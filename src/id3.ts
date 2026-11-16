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
