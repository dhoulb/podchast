// Writes an ID3v2.3 tag with chapter frames (CTOC + CHAP), so podcast apps
// (Apple Podcasts, Pocket Casts, Overcast) show chapters for an MP3.

export type Chapter = { title: string; start: number }; // start in seconds

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function u32(n: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n >>> 0);
	return b;
}

function join(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function frame(id: string, body: Uint8Array): Uint8Array {
	return join([latin1(id), u32(body.length), new Uint8Array(2), body]);
}

/** Text frame in UTF-16 with BOM (encoding 1), the most widely read choice in ID3v2.3. */
function textFrame(id: string, text: string): Uint8Array {
	const utf16 = new Uint8Array(2 + text.length * 2);
	utf16[0] = 0xff;
	utf16[1] = 0xfe;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		utf16[2 + i * 2] = c & 0xff;
		utf16[3 + i * 2] = c >> 8;
	}
	return frame(id, join([new Uint8Array([1]), utf16]));
}

/** Build an ID3v2.3 tag. Returns an empty array when there are fewer than two chapters. */
export function id3Tag(title: string, chapters: Chapter[], totalSeconds: number): Uint8Array {
	const frames: Uint8Array[] = [textFrame("TIT2", title.slice(0, 250))];
	const chs = chapters.slice(0, 255);
	if (chs.length >= 2) {
		const ids = chs.map((_, i) => `ch${i}`);
		frames.push(frame("CTOC", join([latin1("toc\0"), new Uint8Array([0x03, chs.length]), ...ids.map((id) => latin1(`${id}\0`))])));
		chs.forEach((c, i) => {
			const startMs = Math.round(c.start * 1000);
			const endMs = Math.round((chs[i + 1]?.start ?? totalSeconds) * 1000);
			const none = u32(0xffffffff);
			frames.push(frame("CHAP", join([latin1(`${ids[i]}\0`), u32(startMs), u32(endMs), none, none, textFrame("TIT2", c.title.slice(0, 200))])));
		});
	}
	const body = join(frames);
	const n = body.length;
	const size = new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
	return join([latin1("ID3"), new Uint8Array([3, 0, 0]), size, body]);
}

/** Read the chapters back from the start of an MP3 that id3Tag() made. `head` must hold the whole tag. */
export function readChapters(head: Uint8Array): Chapter[] {
	if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return [];
	const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
	const end = Math.min(head.length, 10 + size);
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const out: Chapter[] = [];
	let o = 10;
	while (o + 10 <= end) {
		const id = String.fromCharCode(...head.subarray(o, o + 4));
		const len = view.getUint32(o + 4);
		if (!/^[A-Z0-9]{4}$/.test(id) || o + 10 + len > end) break;
		if (id === "CHAP") {
			const body = head.subarray(o + 10, o + 10 + len);
			const z = body.indexOf(0);
			const start = new DataView(body.buffer, body.byteOffset + z + 1, 4).getUint32(0) / 1000;
			out.push({ title: subTitle(body.subarray(z + 17)), start });
		}
		o += 10 + len;
	}
	return out.sort((a, b) => a.start - b.start);
}

/** The text of the TIT2 frame inside a CHAP frame (UTF-16 with BOM, as textFrame() writes it). */
function subTitle(frames: Uint8Array): string {
	if (frames.length < 11 || String.fromCharCode(...frames.subarray(0, 4)) !== "TIT2") return "";
	const len = new DataView(frames.buffer, frames.byteOffset + 4, 4).getUint32(0);
	const body = frames.subarray(10, 10 + len);
	// Decoded by hand: Workers' TextDecoder only knows UTF-8.
	if (body[0] !== 1) return String.fromCharCode(...body.subarray(1)).replace(/\0+$/, "");
	const le = !(body[1] === 0xfe && body[2] === 0xff);
	let s = "";
	for (let i = 3; i + 1 < body.length; i += 2) s += String.fromCharCode(le ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1]);
	return s.replace(/\0+$/, "");
}
