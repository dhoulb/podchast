// A small MIME reader for email sent to Podchast. No dependencies.
// It finds the subject and the best text body (text/plain, else text/html made plain).

export type Attachment = { name: string; bytes: Uint8Array };
export type Mail = { subject: string; text: string; pdfs: Attachment[] };

type Part = { headers: Map<string, string>; body: string };

export function readMail(raw: string): Mail {
	const top = splitPart(raw);
	const subject = decodeWords(top.headers.get("subject") ?? "").trim();
	const pdfs: Attachment[] = [];
	findPdfs(top, pdfs);
	const plain = findBody(top, "text/plain");
	if (plain !== undefined) return { subject, text: tidy(plain), pdfs };
	const html = findBody(top, "text/html");
	return { subject, text: tidy(html ? htmlToText(html) : ""), pdfs };
}

/** Collect PDF attachments (by type, or by a .pdf file name). */
function findPdfs(part: Part, out: Attachment[], depth = 0): void {
	const ctype = part.headers.get("content-type") ?? "";
	const type = ctype.toLowerCase();
	if ((type.startsWith("multipart/") || type.startsWith("message/rfc822")) && depth < 8) {
		if (type.startsWith("message/rfc822")) return findPdfs(splitPart(part.body), out, depth + 1);
		const boundary = param(ctype, "boundary");
		if (!boundary) return;
		for (const chunk of part.body.split(`--${boundary}`).slice(1)) {
			if (chunk.startsWith("--")) break;
			findPdfs(splitPart(chunk.replace(/^\r?\n/, "")), out, depth + 1);
		}
		return;
	}
	const name = decodeWords(param(part.headers.get("content-disposition") ?? "", "filename") ?? param(ctype, "name") ?? "");
	if (!type.startsWith("application/pdf") && !/\.pdf$/i.test(name)) return;
	const enc = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase().trim();
	const bytes = enc === "base64" ? base64Bytes(part.body) : enc === "quoted-printable" ? qpBytes(part.body) : Uint8Array.from(part.body, (c) => c.charCodeAt(0) & 255);
	if (bytes.length) out.push({ name: name || "document.pdf", bytes });
}

/** Split one MIME part into headers and body. Header names are lower case. */
function splitPart(raw: string): Part {
	const s = raw.replace(/\r\n/g, "\n");
	const end = s.indexOf("\n\n");
	const head = end < 0 ? s : s.slice(0, end);
	const body = end < 0 ? "" : s.slice(end + 2);
	const headers = new Map<string, string>();
	// Folded header lines start with a space or tab.
	for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) {
			const name = line.slice(0, i).trim().toLowerCase();
			if (!headers.has(name)) headers.set(name, line.slice(i + 1).trim());
		}
	}
	return { headers, body };
}

/** Depth-first search for the first part of a type, decoded to a string. */
function findBody(part: Part, want: string, depth = 0): string | undefined {
	const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
	if (type.startsWith("multipart/") && depth < 8) {
		const boundary = param(part.headers.get("content-type") ?? "", "boundary");
		if (!boundary) return undefined;
		for (const chunk of part.body.split(`--${boundary}`).slice(1)) {
			if (chunk.startsWith("--")) break; // Closing boundary.
			const found = findBody(splitPart(chunk.replace(/^\r?\n/, "")), want, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (type.startsWith("message/rfc822") && depth < 8) return findBody(splitPart(part.body), want, depth + 1);
	if (!type.startsWith(want)) return undefined;
	if (/attachment/i.test(part.headers.get("content-disposition") ?? "")) return undefined;
	const charset = param(type, "charset") || "utf-8";
	return decodeBody(part.body, part.headers.get("content-transfer-encoding") ?? "", charset);
}

function param(header: string, name: string): string | undefined {
	const m = header.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
	return m ? (m[1] ?? m[2]) : undefined;
}

function decodeBody(body: string, encoding: string, charset: string): string {
	const enc = encoding.toLowerCase().trim();
	if (enc === "base64") return toText(base64Bytes(body), charset);
	if (enc === "quoted-printable") return toText(qpBytes(body), charset);
	return body;
}

function toText(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

function base64Bytes(s: string): Uint8Array {
	const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, ""));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function qpBytes(s: string, underscoreIsSpace = false): Uint8Array {
	const src = s.replace(/=\r?\n/g, ""); // Soft line breaks.
	const out: number[] = [];
	const utf8 = new TextEncoder();
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
			out.push(parseInt(src.slice(i + 1, i + 3), 16));
			i += 2;
		} else if (c === "_" && underscoreIsSpace) out.push(32);
		else out.push(...utf8.encode(c));
	}
	return new Uint8Array(out);
}

/** RFC 2047 encoded words in headers, such as =?UTF-8?B?...?= or =?UTF-8?Q?...?=. */
export function decodeWords(s: string): string {
	return s
		.replace(/\?=\s+=\?/g, "?==?") // Whitespace between encoded words is ignored.
		.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) =>
			toText(enc.toUpperCase() === "B" ? base64Bytes(data) : qpBytes(data, true), cs),
		);
}

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

/** Remove signatures and quoted replies, and tidy blank lines. */
function tidy(text: string): string {
	const lines: string[] = [];
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (line === "-- " || line === "--") break; // Signature.
		if (/^Sent from my (iPhone|iPad|Android)/i.test(line.trim())) break;
		if (/^On .+ wrote:$/.test(line.trim())) break; // Quoted reply below.
		lines.push(line.replace(/\s+$/, ""));
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
