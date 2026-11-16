// Microsoft Edge "Read aloud" TTS over WebSocket, from a Worker.
// Protocol follows edge-tts (https://github.com/rany2/edge-tts).
import { CHROMIUM_MAJOR_VERSION, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN, generateSecMsGec } from "./edge-drm";

const WSS_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

// Max SSML text bytes for one request (edge-tts uses 4096).
export const EDGE_CHUNK_BYTES = 4000;

const uuid = () => crypto.randomUUID().replaceAll("-", "");
const randomHex = (n: number) =>
	[...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

// JavaScript-style date, e.g. "Mon Nov 16 2026 11:42:00 GMT+0000 (Coordinated Universal Time)".
const dateString = () => {
	const [wd, d, mon, y, t] = new Date().toUTCString().replace(",", "").split(" ");
	return `${wd} ${mon} ${d} ${y} ${t} GMT+0000 (Coordinated Universal Time)`;
};

export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Edge sends the sentence text back as it was in the SSML, escaped.
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// format: an Edge output format, e.g. "audio-24khz-48kbitrate-mono-mp3".
// pause: milliseconds of silence between paragraphs (blank lines). 0 means none.
export type EdgeOptions = { voice: string; rate?: string; pitch?: string; volume?: string; format?: string; pause?: number };
export const EDGE_DEFAULT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** One spoken sentence. Times are in seconds from the start of the audio. */
export type Cue = { start: number; end: number; text: string };

/**
 * Synthesise one chunk of plain text (≤ ~4000 bytes after escaping).
 * Returns MP3 bytes (by default 24kHz 48kbps mono), and the time of each sentence.
 */
/**
 * idleMs: fail when Edge sends nothing for this long. Edge can stream one part
 * slowly for minutes, so a stall, not total time, is the sign of a dead socket.
 * maxMs: hard limit for the whole part.
 */
export async function edgeSynthesise(text: string, opts: EdgeOptions, idleMs = 30_000, maxMs = 300_000): Promise<{ audio: Uint8Array; cues: Cue[] }> {
	const url =
		`${WSS_URL}&ConnectionId=${uuid()}` +
		`&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
	// Do not pass an AbortSignal: it stays tied to the WebSocket and would cut the audio short.
	const handshake = fetch(url, {
		headers: {
			Upgrade: "websocket",
			Pragma: "no-cache",
			"Cache-Control": "no-cache",
			Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
			"User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
			"Accept-Language": "en-US,en;q=0.9",
			Cookie: `muid=${randomHex(16)};`,
		},
	});
	let handshakeTimer: any;
	const resp = await Promise.race([
		handshake,
		new Promise<never>((_, reject) => (handshakeTimer = setTimeout(() => reject(new Error("Edge TTS: connect timeout")), 20_000))),
	]).finally(() => clearTimeout(handshakeTimer));
	const ws = resp.webSocket;
	if (!ws) throw new Error(`Edge TTS: no WebSocket (HTTP ${resp.status}) ${(await resp.text()).slice(0, 200)}`);
	ws.accept();

	const parts: Uint8Array[] = [];
	const cues: Cue[] = [];
	const seen: string[] = []; // Paths of text messages, for error reports.
	const done = new Promise<void>((resolve, reject) => {
		const fail = (why: string) => () => finish(new Error(`Edge TTS: ${why} (text messages: ${seen.length}, audio parts: ${parts.length})`));
		const hardTimer = setTimeout(fail(`timeout after ${maxMs / 1000} s`), maxMs);
		let idleTimer = setTimeout(fail(`no data for ${idleMs / 1000} s`), idleMs);
		let finished = false;
		const finish = (err?: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(hardTimer);
			clearTimeout(idleTimer);
			try {
				ws.close(1000);
			} catch {}
			err ? reject(err) : resolve();
		};
		ws.addEventListener("message", (ev) => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(fail(`no data for ${idleMs / 1000} s`), idleMs);
			const data = ev.data;
			if (typeof data === "string") {
				seen.push(/Path:([\w.]+)/.exec(data)?.[1] ?? "?");
				if (data.includes("Path:turn.end")) finish();
				else if (data.includes("Path:audio.metadata")) cues.push(...readCues(data));
				return;
			}
			const buf = new Uint8Array(data as ArrayBuffer);
			if (buf.length < 2) return;
			const headerLen = (buf[0] << 8) | buf[1];
			const header = decoder.decode(buf.subarray(2, 2 + headerLen));
			if (!header.includes("Path:audio")) return;
			const audio = buf.subarray(2 + headerLen);
			if (audio.length && header.includes("Content-Type:audio/mpeg")) parts.push(audio.slice());
		});
		// A close before "turn.end" means the audio is incomplete.
		ws.addEventListener("close", (ev) => finish(new Error(`Edge TTS: closed early ${ev.code} ${ev.reason} (audio parts: ${parts.length})`)));
		ws.addEventListener("error", () => finish(new Error("Edge TTS: socket error")));
	});

	ws.send(
		`X-Timestamp:${dateString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
			`{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"${opts.format || EDGE_DEFAULT_FORMAT}"}}}}\r\n`,
	);
	const ssml =
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
		`<voice name='${opts.voice}'><prosody pitch='${opts.pitch ?? "+0Hz"}' rate='${opts.rate ?? "+0%"}' volume='${opts.volume ?? "+0%"}'>` +
		`${speechText(text, opts.pause)}</prosody></voice></speak>`;
	ws.send(
		`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateString()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
	);

	await done;
	if (!parts.length) throw new Error("Edge TTS: no audio received");
	return { audio: concat(parts), cues };
}

/** Sentence times from an "audio.metadata" message. Offset and Duration are in 100 ns ticks. */
function readCues(message: string): Cue[] {
	try {
		const body = JSON.parse(message.slice(message.indexOf("\r\n\r\n") + 4)) as {
			Metadata?: { Type: string; Data: { Offset: number; Duration: number; text?: { Text?: string } } }[];
		};
		return (body.Metadata ?? [])
			.filter((m) => m.Type === "SentenceBoundary" && m.Data.text?.Text?.trim())
			.map((m) => ({ start: m.Data.Offset / 1e7, end: (m.Data.Offset + m.Data.Duration) / 1e7, text: unescapeXml(m.Data.text!.Text!.trim()) }));
	} catch {
		return [];
	}
}

/** Escape the text, and put a short silence between paragraphs. */
function speechText(text: string, pause = 0): string {
	const safe = escapeXml(text);
	return pause > 0 ? safe.replace(/\n\s*\n/g, ` <break time='${Math.min(pause, 3000)}ms'/> `) : safe;
}

const decoder = new TextDecoder();

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
