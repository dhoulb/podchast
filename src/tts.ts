import { type Cue, concat, edgeSynthesise } from "./edge-tts";

// Audio is kept as a list of pieces (one for each WebSocket message) and joined only once, when it is saved.
// Joining 10-20 MB several times used a lot of the Free plan's CPU time.
type Pieces = Uint8Array[];
const byteLength = (p: Pieces) => p.reduce((n, a) => n + a.length, 0);
const piecesSeconds = (p: Pieces) => (p.length ? mp3Seconds(p[0], byteLength(p)) : 0);
import { clarify, unmark } from "./clarifications";
import { chunkText } from "./extract";

const EDGE_PARALLEL = 4;

export type Engine = "edge" | "workers-ai";
export type TtsEnv = { AI: Ai; VOICE: string; RATE?: string; PITCH?: string; VOLUME?: string; AI_MODEL: string; AI_SPEAKER?: string; TTS_ENGINE?: string; EDGE_FORMAT?: string; EDGE_PAUSE_MS?: string; CLARIFY?: string; LANG?: string };

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
	let last: unknown;
	for (let i = 0; i < tries; i++) {
		try {
			return await fn();
		} catch (e) {
			last = e;
			if (isPermanent(e)) break;
			await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
		}
	}
	throw last;
}

/**
 * An error that a retry cannot fix: the Workers AI daily free allocation is used
 * up (it resets at 00:00 UTC), or the page or PDF has no text to read.
 */
export function isPermanent(e: unknown): boolean {
	return /"internalCode":4006|daily free allocation|no article text|PDF has no text/.test(String((e as Error)?.message ?? e));
}

/** Audio for each text chunk, in order. Chunk timings let the caller place chapter marks. cues[i] are the sentence times in chunk i, if the engine gives them. */
export type Spoken = { chunks: string[]; audio: Pieces[]; cues?: Cue[][] };

/** Edge options from the env vars. */
const edgeOptions = (env: TtsEnv) => ({ voice: env.VOICE, rate: env.RATE, pitch: env.PITCH, volume: env.VOLUME, format: env.EDGE_FORMAT });

async function edgeAll(env: TtsEnv, text: string): Promise<Spoken> {
	// Edge speaks at about 2 to 3 times real time per connection, so run a few parts at once.
	const chunks = chunkText(text, 3000);
	const parts: Pieces[] = new Array(chunks.length);
	const cues: Cue[][] = new Array(chunks.length);
	let next = 0;
	const worker = async () => {
		while (next < chunks.length) {
			const i = next++;
			const t = Date.now();
			const out = await edgeChunk(env, chunks[i]);
			parts[i] = out.audio;
			cues[i] = out.cues;
			console.log(`Edge TTS part ${i + 1}/${chunks.length}: ${byteLength(parts[i])} bytes, ${cues[i].length} sentences in ${Date.now() - t} ms`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(EDGE_PARALLEL, chunks.length) }, worker));
	return { chunks, audio: parts, cues };
}

// Markers in the script. Edge refuses SSML <break>, so pauses are real silent MP3 frames put between separate Edge requests.
/** Put before a heading paragraph: a long pause before it, and a short one after it. */
export const HEADING = "\uE000";
/** A paragraph that is only this marker: a divider, a long pause. */
export const DIVIDER = "\uE001";
const MARKERS = /[\uE000\uE001]/g;
export const stripMarkers = (s: string) => s.replace(MARKERS, "");

/** Pauses in milliseconds. EDGE_PAUSE_MS sets the pause between paragraphs. */
const HEADING_BEFORE_MS = 1500;
const HEADING_AFTER_MS = 700;
const DIVIDER_MS = 2000;
// Paragraphs are joined into one request up to this length. Edge takes about 4,000 bytes of SSML for each request.
const JOIN_CHARS = 2000;
// Each segment is one Edge request. Keep the subrequests of one chunk job well under the Free plan's 50.
const MAX_SEGMENTS = 12;

/** One piece of text to speak in one request, and the silence (ms) before it. heading: the text is a heading. */
export type Segment = { text: string; pause: number; heading?: boolean };

/**
 * Split a chunk at headings and dividers. Each heading is its own request, so its silence and chapter time are exact.
 * The paragraphs between them are joined into one request (up to JOIN_CHARS), with "\n\n" between paragraphs.
 */
export function segments(text: string, paragraphMs: number): Segment[] {
	const out: (Segment & { para: boolean })[] = [];
	let pause = paragraphMs;
	for (const raw of text.split(/\n{2,}/)) {
		const t = raw.trim();
		if (!t) continue;
		if (t === DIVIDER) {
			pause = Math.max(pause, DIVIDER_MS);
			continue;
		}
		if (t.startsWith(HEADING)) {
			const h = stripMarkers(t).trim();
			if (h) out.push({ text: h, pause: Math.max(pause, HEADING_BEFORE_MS), para: false, heading: true });
			pause = HEADING_AFTER_MS;
			continue;
		}
		const clean = stripMarkers(t).trim();
		// Edge sends no audio for text with no letters or digits, and that fails the job.
		if (!/[\p{L}\p{N}]/u.test(clean)) continue;
		// Paragraphs in one section go in one request, up to JOIN_CHARS. The "paragraph-pause"
		// clarification turns each "\n\n" into marks that Edge reads as a 1 second pause.
		const last = out.at(-1);
		if (last?.para && pause <= paragraphMs && last.text.length + clean.length <= JOIN_CHARS) last.text += `\n\n${clean}`;
		else out.push({ text: clean, pause, para: true });
		pause = paragraphMs;
	}
	// Too many requests: join the shortest pair that only has a paragraph pause between them.
	while (out.length > MAX_SEGMENTS) {
		let best = -1;
		for (let i = 0; i + 1 < out.length; i++) {
			if (!out[i].para || !out[i + 1].para || out[i + 1].pause > paragraphMs) continue;
			if (best < 0 || out[i].text.length + out[i + 1].text.length < out[best].text.length + out[best + 1].text.length) best = i;
		}
		if (best < 0) break;
		out[best].text += `\n\n${out[best + 1].text}`;
		out.splice(best + 1, 1);
	}
	return out.map(({ text, pause, heading }) => (heading ? { text, pause, heading } : { text, pause }));
}

/**
 * Silent MP3 frames in the same format as `mp3` (taken from its first frame), for about `ms` milliseconds.
 * A frame with all-zero side info and data decodes as silence. Returns undefined if the format is not known.
 */
export function silence(mp3: Uint8Array, ms: number): { bytes: Uint8Array; seconds: number } | undefined {
	if (ms <= 0) return undefined;
	for (let i = 0; i + 4 < Math.min(mp3.length, 65536); i++) {
		if (mp3[i] !== 0xff || (mp3[i + 1] & 0xe0) !== 0xe0) continue;
		const version = (mp3[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
		const layer = (mp3[i + 1] >> 1) & 3; // 1 = Layer III
		const noCrc = mp3[i + 1] & 1;
		const bi = mp3[i + 2] >> 4;
		const si = (mp3[i + 2] >> 2) & 3;
		if (version === 1 || layer !== 1 || !noCrc || bi === 0 || bi === 15 || si === 3) continue;
		const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
		const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
		const kbps = (version === 3 ? v1 : v2)[bi];
		const rate = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]][version][si];
		const samples = version === 3 ? 1152 : 576;
		const len = Math.floor(((samples / 8) * kbps * 1000) / rate);
		const frame = new Uint8Array(len);
		frame.set(mp3.subarray(i, i + 4));
		frame[2] &= ~0x02; // No padding byte.
		const n = Math.max(1, Math.round(((ms / 1000) * rate) / samples));
		const bytes = new Uint8Array(n * len);
		for (let k = 0; k < n; k++) bytes.set(frame, k * len);
		return { bytes, seconds: (n * samples) / rate };
	}
	return undefined;
}

/** Speak one chunk with Edge: one request for each segment, with silence between them. */
async function edgeChunk(env: TtsEnv, text: string): Promise<{ audio: Pieces; cues: Cue[]; seconds: number }> {
	const audio: Pieces = [];
	const cues: Cue[] = [];
	let t = 0;
	for (const seg of segments(text, Number(env.EDGE_PAUSE_MS) || 0)) {
		// Clarifications rewrite text that Edge reads badly (src/clarifications.ts). CLARIFY=off turns them off.
		const say = env.CLARIFY === "off" ? seg.text : clarify(seg.text, { heading: seg.heading, lang: env.LANG });
		if (!/[\p{L}\p{N}]/u.test(say)) continue;
		const r = await retry(() => edgeSynthesise(say, edgeOptions(env)), 2);
		const gap = silence(r.audio[0], seg.pause);
		if (gap) {
			audio.push(gap.bytes);
			t += gap.seconds;
		}
		// Edge sends back what it spoke, with the pause marks. The transcript shows the text without them.
		for (const c of r.cues) {
			const text = unmark(c.text);
			if (/[\p{L}\p{N}]/u.test(text)) cues.push({ start: c.start + t, end: c.end + t, text });
		}
		audio.push(...r.audio);
		t += piecesSeconds(r.audio);
	}
	if (!audio.length) throw new Error("Edge TTS: nothing to say in this chunk");
	return { audio, cues, seconds: t };
}

async function aiAll(env: TtsEnv, text: string): Promise<Spoken> {
	const parts: Pieces[] = [];
	const chunks = chunkText(stripMarkers(text), 1800);
	for (const chunk of chunks) {
		parts.push(
			await retry(async () => {
				const input: Record<string, string> = { text: chunk, encoding: "mp3" };
				if (env.AI_SPEAKER) input.speaker = env.AI_SPEAKER;
				const resp = (await env.AI.run(env.AI_MODEL as any, input as any, { returnRawResponse: true } as any)) as unknown as Response;
				if (!resp.ok) throw new Error(`Workers AI TTS: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
				return [new Uint8Array(await resp.arrayBuffer())];
			}),
		);
	}
	return { chunks, audio: parts };
}

/** pieces: the MP3 in order, to join once. vtt is a WebVTT transcript with one cue for each sentence. */
export type Speech = { pieces: Uint8Array[]; seconds: number; mp3: Uint8Array; engine: Engine; edgeError?: string; marks: (needle: string) => number | undefined; vtt: string };

// Text for one chunk job. Edge takes about 4,000 bytes of SSML for each request.
export const CHUNK_CHARS = 3000;

/** Speak one chunk (CHUNK_CHARS or less) for a chunk job. Edge TTS first, then Workers AI if TTS_ENGINE allows. */
export async function speakChunk(env: TtsEnv, text: string): Promise<{ mp3: Uint8Array; seconds: number; cues?: Cue[]; engine: Engine; edgeError?: string }> {
	const out = (s: Spoken, engine: Engine, edgeError?: string) => {
		const pieces = s.audio.flat();
		return { mp3: concat(pieces), seconds: s.audio.reduce((t, p) => t + piecesSeconds(p), 0), cues: s.cues?.flat(), engine, edgeError };
	};
	if (env.TTS_ENGINE !== "workers-ai") {
		try {
			const r = await edgeChunk(env, text);
			return { mp3: concat(r.audio), seconds: r.seconds, cues: r.cues, engine: "edge" };
		} catch (e) {
			if (env.TTS_ENGINE === "edge-only") throw e;
			const edgeError = String((e as Error)?.message ?? e);
			return out(await aiAll(env, text), "workers-ai", edgeError);
		}
	}
	return out(await aiAll(env, text), "workers-ai");
}

/** Speak the text. Uses Edge TTS first, then Workers AI if Edge fails. */
export async function speak(env: TtsEnv, text: string): Promise<Speech> {
	const done = (s: Spoken, engine: Engine, edgeError?: string): Speech => {
		const pieces = s.audio.flat();
		return {
			pieces,
			seconds: s.audio.reduce((t, p) => t + piecesSeconds(p), 0),
			// Joined only if a caller asks for it.
			get mp3() {
				return concat(pieces);
			},
			engine,
			edgeError,
			marks: timeFinder(s),
			vtt: webVtt(s),
		};
	};
	if (env.TTS_ENGINE !== "workers-ai") {
		try {
			return done(await edgeAll(env, text), "edge");
		} catch (e) {
			if (env.TTS_ENGINE === "edge-only") throw e;
			const edgeError = String((e as Error)?.message ?? e);
			console.error("Edge TTS failed, using Workers AI:", edgeError);
			return done(await aiAll(env, text), "workers-ai", edgeError);
		}
	}
	return done(await aiAll(env, text), "workers-ai");
}

/**
 * Returns a function that finds the time (seconds) where a piece of text is spoken.
 * Search goes forward only, so call it in text order. The time inside a chunk is
 * estimated from the character position, which is accurate to a few seconds.
 */
function timeFinder({ chunks, audio }: Spoken): (needle: string) => number | undefined {
	return chunkTimes(chunks, audio.map(piecesSeconds));
}

/** Like timeFinder, from the text and length (seconds) of each chunk. */
export function chunkTimes(chunks: string[], seconds: number[]): (needle: string) => number | undefined {
	const starts: number[] = [];
	let t = 0;
	for (const len of seconds) {
		starts.push(t);
		t += len;
	}
	let ci = 0;
	let from = 0;
	return (needle) => {
		for (let i = ci; i < chunks.length; i++) {
			const pos = chunks[i].indexOf(needle, i === ci ? from : 0);
			if (pos < 0) continue;
			ci = i;
			from = pos + needle.length;
			return starts[i] + (pos / chunks[i].length) * seconds[i];
		}
		return undefined;
	};
}

/**
 * A WebVTT transcript for the whole episode. Each chunk is its own MP3, so its
 * sentence times are moved by the length of the chunks before it. A chunk with
 * no sentence times (Workers AI, or Edge sent none) gets times estimated from
 * the length of each sentence.
 */
export function webVtt({ chunks, audio, cues }: Spoken): string {
	return chunkVtt(chunks, audio.map(piecesSeconds), cues);
}

/** Like webVtt, from the text, length (seconds) and sentence times of each chunk. */
export function chunkVtt(chunks: string[], seconds: number[], cues?: (Cue[] | undefined)[]): string {
	const out: Cue[] = [];
	let t = 0;
	seconds.forEach((len, i) => {
		const own = cues?.[i]?.length ? cues[i] : estimateCues(chunks[i], len);
		for (const c of own) {
			const start = Math.max(t + Math.min(c.start, len), out.at(-1)?.end ?? 0);
			const end = Math.max(start + 0.1, t + Math.min(c.end, len));
			out.push({ start, end, text: c.text });
		}
		t += len;
	});
	const time = (s: number) => {
		const ms = Math.round(s * 1000);
		const p = (n: number, w = 2) => String(n).padStart(w, "0");
		return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
	};
	const text = (s: string) => s.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `WEBVTT\n\n${out.map((c) => `${time(c.start)} --> ${time(c.end)}\n${text(c.text)}\n`).join("\n")}`;
}

/** Split text into sentences, and share the duration between them by length. */
function estimateCues(text: string, seconds: number): Cue[] {
	const sentences = (stripMarkers(text).match(/[^.!?\n]+[.!?]+["'\u201d\u2019)]*|[^.!?\n]+/g) ?? []).map((s) => s.trim()).filter(Boolean);
	const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
	let t = 0;
	return sentences.map((s) => {
		const start = t;
		t += (s.length / total) * seconds;
		return { start, end: t, text: s };
	});
}

/** MP3 duration in whole seconds. */
export const mp3Duration = (mp3: Uint8Array): number => Math.round(mp3Seconds(mp3));

/** Estimate MP3 duration in seconds from the first frame's bitrate (CBR). total: the full length, if mp3 is only the first piece. */
export function mp3Seconds(mp3: Uint8Array, total = mp3.length): number {
	let i = 0;
	if (mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) {
		i = 10 + ((mp3[6] & 0x7f) << 21) + ((mp3[7] & 0x7f) << 14) + ((mp3[8] & 0x7f) << 7) + (mp3[9] & 0x7f);
	}
	const end = Math.min(mp3.length - 4, i + 65536);
	for (; i < end; i++) {
		if (mp3[i] !== 0xff || (mp3[i + 1] & 0xe0) !== 0xe0) continue;
		const version = (mp3[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
		const layer = (mp3[i + 1] >> 1) & 3; // 1 = Layer III
		const idx = mp3[i + 2] >> 4;
		if (layer !== 1 || idx === 0 || idx === 15) continue;
		const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
		const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
		const kbps = (version === 3 ? v1 : v2)[idx];
		return ((total - i) * 8) / (kbps * 1000);
	}
	return (total * 8) / 48000;
}
