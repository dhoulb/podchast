// Draws the 1400x1400 podcast cover (a microphone) as a palette PNG at runtime.
// Podcast apps want PNG or JPEG artwork, and drawing it keeps the bundle small.

const SIZE = 1400;
const PALETTE = [0x1f, 0x2a, 0x44, 0xf4, 0xb8, 0x60]; // 0 = navy, 1 = amber

function pixel(x: number, y: number): number {
	const cx = 700;
	// Capsule head: x 600..800, y 330..730, radius 100.
	if (x >= 600 && x <= 800) {
		const cy = y < 430 ? 430 : y > 630 ? 630 : y;
		if ((x - cx) ** 2 + (y - cy) ** 2 <= 100 ** 2) return 1;
	}
	// Cradle: lower half ring, centre (700, 610), radii 240..300.
	if (y >= 610) {
		const d = Math.hypot(x - cx, y - 610);
		if (d >= 240 && d <= 300) return 1;
	}
	// Stand and base.
	if (x >= 670 && x <= 730 && y >= 905 && y <= 1040) return 1;
	if (y >= 1020 && y <= 1070 && x >= 520 && x <= 880) {
		const ex = x < 545 ? 545 : x > 855 ? 855 : x;
		if ((x - ex) ** 2 + (y - 1045) ** 2 <= 25 ** 2) return 1;
	}
	return 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const v = new DataView(out.buffer);
	v.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

let cached: Uint8Array | null = null;

export async function coverPng(): Promise<Uint8Array> {
	if (cached) return cached;
	// 1 bit per pixel, each row starts with filter byte 0.
	const rowBytes = 1 + SIZE / 8;
	const raw = new Uint8Array(rowBytes * SIZE);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) if (pixel(x, y)) raw[y * rowBytes + 1 + (x >> 3)] |= 0x80 >> (x & 7);
	}
	const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
	const ihdr = new Uint8Array(13);
	const hv = new DataView(ihdr.buffer);
	hv.setUint32(0, SIZE);
	hv.setUint32(4, SIZE);
	ihdr.set([1, 3, 0, 0, 0], 8); // bit depth 1, palette colour
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("PLTE", new Uint8Array(PALETTE)),
		chunk("IDAT", idat),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return (cached = out);
}
