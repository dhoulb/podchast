// Show notes: the sections (chapter times) and the links that an article mentions.
// notes/<id>.json keeps them all. Its customMetadata keeps as much as fits in 2 KB,
// so one list() call gets the notes of every episode for the feed.

export type Link = { url: string; text: string };

const MAX_LINKS = 100;
// customMetadata is limited to 2 KB in total. Leave room for the key name and the JSON brackets.
const META_BYTES = 1900;

/** Make links tidy: absolute http(s) only, no links to the same page, no repeats, short text. */
export function cleanLinks(links: Link[], page?: string): Link[] {
	const self = page ? noHash(page) : undefined;
	const seen = new Map<string, Link>();
	for (const l of links) {
		let url: string;
		try {
			const u = new URL(l.url, page);
			if (u.protocol !== "https:" && u.protocol !== "http:") continue;
			url = u.href;
		} catch {
			continue;
		}
		if (url.length > 2000 || noHash(url) === self) continue;
		let text = l.text.replace(/\s+/g, " ").trim();
		if (sameUrl(text, url)) text = "";
		if (text.length > 120) text = `${text.slice(0, 119).replace(/\s+\S*$/, "")}…`;
		const had = seen.get(url);
		if (had) {
			if (!had.text) had.text = text;
			continue;
		}
		seen.set(url, { url, text });
		if (seen.size >= MAX_LINKS) break;
	}
	return [...seen.values()];
}

/** Links in markdown or plain text: [text](url), <url>, and bare URLs. Images are left out. */
export function markdownLinks(md: string): Link[] {
	const out: Link[] = [];
	const re = /(!?)\[((?:\\.|[^\]\\])*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>()[\]"'`]+)/g;
	for (const m of md.matchAll(re)) {
		if (m[3]) {
			if (m[1]) continue;
			out.push({ url: m[3], text: plainText(m[2]) });
		} else if (m[4]) out.push({ url: m[4], text: "" });
		else if (m[5]) out.push({ url: m[5].replace(/[.,;:!?*_~]+$/, ""), text: "" });
	}
	return cleanLinks(out);
}

/** Show notes for one episode: the section times and the links. */
export type Notes = { chapters?: Chapter[]; links?: Link[] };
export type Chapter = { title: string; start: number }; // start in seconds
// What the feed gets from customMetadata: what fits, and the full link count.
export type NotesMeta = { chapters: Chapter[]; links: Link[]; total: number };

/** As much of the notes as fits in customMetadata, as compact JSON. Chapters first, then links. */
export function notesMeta(n: Notes): string {
	const c: [number, string][] = [];
	const l: [string, string][] = [];
	const total = n.links?.length ?? 0;
	const size = () => bytes(JSON.stringify({ c, l, n: total }));
	for (const ch of n.chapters ?? []) {
		c.push([Math.round(ch.start), ch.title.slice(0, 80)]);
		if (size() > META_BYTES) {
			c.pop();
			break;
		}
	}
	for (const link of n.links ?? []) {
		l.push([link.url, link.text.slice(0, 60)]);
		if (size() > META_BYTES) {
			l.pop();
			break;
		}
	}
	return JSON.stringify({ c, l, n: total });
}

/** Read notes back from notesMeta(). */
export function parseNotesMeta(s: string | undefined): NotesMeta {
	try {
		const m = JSON.parse(s ?? "") as { c?: [number, string][]; l?: [string, string][]; n?: number };
		const links = (m.l ?? []).map(([url, text]) => ({ url, text }));
		return { chapters: (m.c ?? []).map(([start, title]) => ({ start, title })), links, total: Math.max(m.n ?? 0, links.length) };
	} catch {
		return { chapters: [], links: [], total: 0 };
	}
}

/** A time that podcast apps make tappable in show notes: "4:05" or "1:02:03". */
export function stamp(sec: number): string {
	const s = Math.max(0, Math.floor(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The notes as HTML paragraphs for <content:encoded>. `more` is a page with all the links. */
export function notesHtml(n: NotesMeta, more?: string): string[] {
	const out: string[] = [];
	if (n.chapters.length >= 2) out.push(`<p><b>Sections</b><br>${n.chapters.map((c) => `${stamp(c.start)} ${esc(c.title)}`).join("<br>")}</p>`);
	if (n.links.length) {
		out.push(`<p><b>Links</b></p><ul>${n.links.map((l) => `<li><a href="${esc(l.url)}">${esc(linkLabel(l))}</a>${l.text ? ` (${esc(linkHost(l.url))})` : ""}</li>`).join("")}</ul>`);
		if (n.total > n.links.length && more) out.push(`<p><a href="${esc(more)}">All ${n.total} links</a></p>`);
	}
	return out;
}

/** The section times as plain text, for <description>. */
export function notesText(n: NotesMeta): string {
	return n.chapters.length >= 2 ? `Sections:\n${n.chapters.map((c) => `${stamp(c.start)} ${c.title}`).join("\n")}` : "";
}

/** The host name, without "www.". */
export function linkHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** What to show for a link: its text, else the host and path without "https://". */
export function linkLabel(l: Link): string {
	if (l.text) return l.text;
	const short = l.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
	return short.length > 80 ? `${short.slice(0, 79)}…` : short;
}

const noHash = (url: string) => url.replace(/#.*$/, "").replace(/\/$/, "");
const sameUrl = (text: string, url: string) => {
	const strip = (s: string) => s.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "").toLowerCase();
	return strip(text) === strip(url);
};
// Link text from markdown: escapes, emphasis and code marks are taken out.
const plainText = (s: string) =>
	s
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, "$1")
		.replace(/(\*+|__|~~|`)/g, "")
		.trim();

const bytes = (s: string) => new TextEncoder().encode(s).length;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
