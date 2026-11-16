import { type Cue, concat, edgeSynthesise } from "./edge-tts";
import { chunkText } from "./extract";

const EDGE_PARALLEL = 4;

export type Engine = "edge" | "workers-ai";
export type TtsEnv = { AI: Ai; VOICE: string; RATE?: string; AI_MODEL: string; AI_SPEAKER?: string; TTS_ENGINE?: string; EDGE_FORMAT?: string; EDGE_PAUSE_MS?: string };

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
	let last: unknown;
	for (let i = 0; i < tries; i++) {
		try {
			return await fn();
		} catch (e) {
			last = e;
			await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
		}
	}
	throw last;
}

/** Audio for each text chunk, in order. Chunk timings let the caller place chapter marks. cues[i] are the sentence times in chunk i, if the engine gives them. */
export type Spoken = { chunks: string[]; audio: Uint8Array[]; cues?: Cue[][] };

async function edgeAll(env: TtsEnv, text: string): Promise<Spoken> {
	// Edge speaks at about 2 to 3 times real time per connection, so run a few parts at once.
	const chunks = chunkText(text, 3000);
	const parts: Uint8Array[] = new Array(chunks.length);
	const cues: Cue[][] = new Array(chunks.length);
	let next = 0;
	const worker = async () => {
		while (next < chunks.length) {
			const i = next++;
			const t = Date.now();
			const out = await retry(() => edgeSynthesise(chunks[i], { voice: env.VOICE, rate: env.RATE, format: env.EDGE_FORMAT, pause: Number(env.EDGE_PAUSE_MS) || 0 }, 90_000), 3);
			parts[i] = out.audio;
			cues[i] = out.cues;
			console.log(`Edge TTS part ${i + 1}/${chunks.length}: ${parts[i].length} bytes, ${cues[i].length} sentences in ${Date.now() - t} ms`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(EDGE_PARALLEL, chunks.length) }, worker));
	return { chunks, audio: parts, cues };
}

async function aiAll(env: TtsEnv, text: string): Promise<Spoken> {
	const parts: Uint8Array[] = [];
	const chunks = chunkText(text, 1800);
	for (const chunk of chunks) {
		parts.push(
			await retry(async () => {
				const input: Record<string, string> = { text: chunk, encoding: "mp3" };
				if (env.AI_SPEAKER) input.speaker = env.AI_SPEAKER;
				const resp = (await env.AI.run(env.AI_MODEL as any, input as any, { returnRawResponse: true } as any)) as unknown as Response;
				if (!resp.ok) throw new Error(`Workers AI TTS: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
				return new Uint8Array(await resp.arrayBuffer());
			}),
		);
	}
	return { chunks, audio: parts };
}

/** vtt is a WebVTT transcript with one cue for each sentence. */
export type Speech = { mp3: Uint8Array; engine: Engine; edgeError?: string; marks: (needle: string) => number | undefined; vtt: string };

/** Speak the text. Uses Edge TTS first, then Workers AI if Edge fails. */
export async function speak(env: TtsEnv, text: string): Promise<Speech> {
	const done = (s: Spoken, engine: Engine, edgeError?: string): Speech => ({ mp3: concat(s.audio), engine, edgeError, marks: timeFinder(s), vtt: webVtt(s) });
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
	const starts: number[] = [];
	let t = 0;
	for (const a of audio) {
		starts.push(t);
		t += mp3Seconds(a);
	}
	let ci = 0;
	let from = 0;
	return (needle) => {
		for (let i = ci; i < chunks.length; i++) {
			const pos = chunks[i].indexOf(needle, i === ci ? from : 0);
			if (pos < 0) continue;
			ci = i;
			from = pos + needle.length;
			return starts[i] + (pos / chunks[i].length) * mp3Seconds(audio[i]);
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
	const out: Cue[] = [];
	let t = 0;
	audio.forEach((a, i) => {
		const len = mp3Seconds(a);
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
	const sentences = (text.match(/[^.!?\n]+[.!?]+["'\u201d\u2019)]*|[^.!?\n]+/g) ?? []).map((s) => s.trim()).filter(Boolean);
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

/** Estimate MP3 duration in seconds from the first frame's bitrate (CBR). */
export function mp3Seconds(mp3: Uint8Array): number {
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
		return ((mp3.length - i) * 8) / (kbps * 1000);
	}
	return (mp3.length * 8) / 48000;
}
