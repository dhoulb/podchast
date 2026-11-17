import cover from "../assets/cover.jpg";
import hero from "../assets/hero.jpg";
import icon180 from "../assets/icon-180.png";
import icon192 from "../assets/icon-192.png";
import icon512 from "../assets/icon-512.png";
import { type Article, chunkText, fetchArticle } from "./extract";
import { readMail } from "./mail";
import { concat } from "./edge-tts";
import { type Chapter, id3Tag } from "./id3";
import { CHUNK_CHARS, chunkTimes, chunkVtt, isPermanent, mp3Duration, speak, speakChunk, type TtsEnv } from "./tts";
import type { Cue } from "./edge-tts";

export interface Env extends TtsEnv {
	AUDIO: R2Bucket;
	JOBS: Queue<Job>;
	TOKEN: string; // Secret. Guards /add and is part of the feed URL.
	FEED_TITLE: string;
	RETENTION_DAYS: string;
	SHORTCUT_URL?: string; // iCloud link to the iOS Shortcut, shown on the status page.
	DOMAIN?: string; // Custom domain, such as podchast.example.com. Links use it, and pages on workers.dev go to it.
	EMAIL_TO?: string; // Address that Email Routing sends to this Worker, shown on the status page.
	EMAIL_FROM?: string; // Secret. Sender addresses (or @domains) allowed to email Podchast. Separate them with commas, spaces or new lines, in any mix.
}

// Debug jobs: "edge" and "workers-ai" speak `text` (or a test sentence) into debug/<id>.mp3. The voice, EDGE_FORMAT and EDGE_PAUSE_MS can be set for one job.
// An item's audio is made in three steps. A job with only `id` reads the article and plans the chunks.
// A job with `chunk` speaks one chunk. A job with `join` puts the chunks together into one episode.
// `run` names one try of the whole item, so jobs from an older try do nothing.
type Job = { id: string; run?: string; chunk?: number; join?: boolean; debug?: "edge" | "workers-ai" | "extract"; url?: string; force?: boolean; text?: string; format?: string; pause?: number; voice?: string; rate?: string; pitch?: string };

type Status = "queued" | "processing" | "done" | "failed";
type Item = {
	id: string;
	url: string;
	status: Status;
	created: string;
	title?: string;
	byline?: string;
	site?: string;
	excerpt?: string;
	bytes?: number;
	duration?: number;
	engine?: string;
	chars?: number;
	error?: string;
	updated?: string;
	part?: number; // Set on long articles that are split into several episodes.
	parts?: number;
	words?: number;
	image?: string; // Article image (og:image), used as episode art.
	chapters?: number;
	text?: boolean; // Made from text sent to /add, not from a web page.
	saved?: boolean; // A copy of the text is kept forever in read/<id>.md.
	pdf?: boolean; // The original PDF is kept forever in read/<id>.pdf.
	gone?: boolean; // The audio was deleted after RETENTION_DAYS. Only the text is left (🍖 MEAT).
	aired?: string; // When the audio was last made, if it was made again. The feed uses it for the date.
	transcript?: boolean; // A timed transcript is in audio/<id>.vtt. It is deleted with the audio.
	attempt?: number; // The queue try that is running, or that ran last.
	retryAt?: string; // When the queue tries again, after a failed try.
	run?: string; // The current try. Its chunks are in chunks/<id>/<run>/.
	chunks?: number; // How many chunks the current try speaks.
	progress?: { done: number; last: number }; // Status page only, never saved: chunks done, and the time of the last one.
};

// Text for one episode, with the headings that become chapters.
type PartText = { text: string; headings: string[] };

// ---------- Storage (R2 only) ----------
// items/<id>  JSON item, also copied into customMetadata so one list() call builds the feed.
// audio/<id>.mp3  Deleted after RETENTION_DAYS. The item stays.
// audio/<id>.vtt  Timed transcript (WebVTT). In audio/, so it is deleted with the MP3.
// parts/<id>.txt  Text for one part of a long article, deleted when that part is done.
// read/<id>.md    The article text, kept forever. read/<id>.pdf is the original PDF, if there was one.

const itemKey = (id: string) => `items/${id}`;
const partKey = (id: string) => `parts/${id}.txt`;
const readKey = (id: string) => `read/${id}.md`;
const pdfKey = (id: string) => `read/${id}.pdf`;
// Part 2 of an article shares the text of part 1.
const rootId = (id: string) => id.replace(/-p\d+$/, "");

// chunks/<id>/<run>/plan.json  The text of each chunk, and the headings.
// chunks/<id>/<run>/<n>.mp3     The audio of chunk n. <n>.json has its length and sentence times.
// The join job deletes them. A lifecycle rule deletes any that are left after 7 days.
const chunkDir = (id: string, run: string) => `chunks/${id}/${run}/`;
type Plan = { chunks: string[]; headings: string[]; again: boolean };
type ChunkMeta = { seconds: number; bytes: number; cues?: Cue[]; engine: string; edgeError?: string };

async function getJson<T>(env: Env, key: string): Promise<T | null> {
	const obj = await env.AUDIO.get(key);
	return obj ? ((await obj.json()) as T) : null;
}
// Biggest text /add takes (about 7 hours of audio).
const MAX_TEXT = 400_000;
const audioKey = (id: string) => `audio/${id}.mp3`;
const transcriptKey = (id: string) => `audio/${id}.vtt`;

async function saveItem(env: Env, item: Item): Promise<void> {
	item.updated = new Date().toISOString();
	const meta: Item = { ...item };
	// customMetadata is limited to 2 KB in total.
	meta.title = meta.title?.slice(0, 300);
	meta.excerpt = meta.excerpt?.slice(0, 600);
	meta.byline = meta.byline?.slice(0, 120);
	meta.error = meta.error?.slice(0, 300);
	meta.url = meta.url.slice(0, 500);
	const json = JSON.stringify(meta);
	await env.AUDIO.put(itemKey(item.id), JSON.stringify(item), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: { item: json },
	});
}

async function loadItem(env: Env, id: string): Promise<Item | null> {
	const obj = await env.AUDIO.get(itemKey(id));
	return obj ? ((await obj.json()) as Item) : null;
}

async function listItems(env: Env): Promise<Item[]> {
	const items: Item[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.AUDIO.list({ prefix: "items/", include: ["customMetadata"], cursor, limit: 1000 });
		for (const o of page.objects) {
			try {
				items.push(JSON.parse(o.customMetadata?.item ?? ""));
			} catch {}
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return items.sort((a, b) => b.created.localeCompare(a.created));
}

const retentionDays = (env: Env) => Number(env.RETENTION_DAYS) || 90;
const retentionMs = (env: Env) => retentionDays(env) * 86400_000;

function newId(): string {
	const rand = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${Date.now().toString(36)}-${rand}`;
}

// ---------- HTTP ----------

function safeEqual(a: string, b: string): boolean {
	if (!a || !b || a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

function findUrl(s: string): string | null {
	const m = s.match(/https?:\/\/[^\s<>"']+/i);
	if (!m) return null;
	try {
		const u = new URL(m[0].replace(/[).,;!?]+$/, ""));
		return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
	} catch {
		return null;
	}
}

type AddRequest = { token: string; target: string | null; content?: string; title?: string; pdf?: Uint8Array };

async function readAddRequest(req: Request, url: URL): Promise<AddRequest> {
	let token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-token") || url.searchParams.get("token") || "";
	// Android's share target sends the link as url, text or title.
	let raw = url.searchParams.get("url") || url.searchParams.get("text") || url.searchParams.get("title") || "";
	// Text to read aloud instead of a web page. With content, url is only the source link.
	let content = "";
	let title = "";
	if (req.method === "POST") {
		const type = req.headers.get("content-type") ?? "";
		if (type.includes("application/json")) {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
			content = str(body.content);
			title = str(body.title);
			raw = content ? str(body.url) : String(body.url ?? body.text ?? body.input ?? raw);
			token ||= str(body.token);
		} else if (type.includes("form")) {
			const form = await req.formData();
			content = str(form.get("content"));
			title = str(form.get("title"));
			raw = String(form.get("url") ?? raw);
			token ||= str(form.get("token"));
		} else {
			const body = await req.text();
			// A plain-text body is a link, unless it has no link and is long enough to be the text itself.
			if (body && !findUrl(body) && body.trim().length > 200) content = body;
			else raw = body || raw;
		}
	}
	content = content.trim();
	return { token, target: findUrl(raw), content: content || undefined, title: title.trim().slice(0, 300) || undefined };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Add a link or text. A link that is already in the ABYSS is not added again: the old item is used, and chewed again if it needs it. */
async function addItem(env: Env, add: AddRequest): Promise<{ item: Item; same?: string }> {
	if (add.target && !add.content && !add.pdf) {
		const old = (await listItems(env)).find((i) => i.url === add.target && (i.part ?? 1) === 1);
		const item = old && (await loadItem(env, old.id));
		if (item) {
			const v = view(item);
			if (v.state === "chewing" || v.state === "waiting") return { item, same: "Already in my 🕳️ ABYSS. I am still 🦷 CHEWING it." };
			if (v.state === "done") return { item, same: "Already in my 🕳️ ABYSS. It is in your feed." };
			return { item: await rechomp(env, item), same: "Already in my 🕳️ ABYSS. Chewing it again." };
		}
	}
	const item: Item = { id: newId(), url: add.target ?? "", status: "queued", created: new Date().toISOString() };
	if (add.content) {
		// Keep the text forever. The job reads it from there.
		item.text = true;
		item.saved = true;
		item.title = add.title;
		await env.AUDIO.put(readKey(item.id), add.content, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
	}
	if (add.pdf) {
		item.pdf = true;
		await env.AUDIO.put(pdfKey(item.id), add.pdf, { httpMetadata: { contentType: "application/pdf" } });
	}
	await saveItem(env, item);
	await env.JOBS.send({ id: item.id });
	return { item };
}

/** Queue an item again from attempt 1. A done episode is made again from the kept text, with a new date, like 🍖 MEAT. */
async function rechomp(env: Env, found: Item): Promise<Item> {
	let item = found;
	// The text of a later part is deleted when the part is done. Then re-chomp the whole article from part 1.
	if ((item.part ?? 1) > 1 && !(await env.AUDIO.head(partKey(item.id)))) item = (await loadItem(env, rootId(item.id))) ?? item;
	const force = item.status === "done";
	if (!force) {
		// Remove the length of the "spat out" clip from an earlier failure.
		item.bytes = undefined;
		item.duration = undefined;
	}
	item.status = "queued";
	item.error = undefined;
	item.attempt = undefined;
	item.retryAt = undefined;
	await saveItem(env, item);
	await env.JOBS.send({ id: item.id, force });
	return item;
}

async function serveAudio(env: Env, req: Request, id: string, download?: string): Promise<Response> {
	const obj = await env.AUDIO.get(audioKey(id), { range: req.headers, onlyIf: req.headers });
	if (!obj) return new Response("Not found", { status: 404 });
	const headers = new Headers({
		"Content-Type": "audio/mpeg",
		"Accept-Ranges": "bytes",
		ETag: obj.httpEtag,
		"Cache-Control": "private, max-age=86400",
	});
	if (download) headers.set("Content-Disposition", `attachment; filename="${download}"`);
	if (!("body" in obj)) return new Response(null, { status: 304, headers });
	const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
	if (r && req.headers.has("range")) {
		const start = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
		const len = r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - start);
		headers.set("Content-Range", `bytes ${start}-${start + len - 1}/${obj.size}`);
		headers.set("Content-Length", String(len));
		return new Response(req.method === "HEAD" ? null : obj.body, { status: 206, headers });
	}
	headers.set("Content-Length", String(obj.size));
	return new Response(req.method === "HEAD" ? null : obj.body, { headers });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function hms(sec = 0): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function feedXml(env: Env, origin: string, items: Item[], file = FEED): string {
	const base = `${origin}/${env.TOKEN}`;
	const about = esc(`${growl(retentionDays(env))}\n\nFeed my 🫦 MOUTH here: ${base}`);
	const title = env.FEED_TITLE || "Podchast";
	// Only audio goes in the feed. Old audio is deleted, so old items leave the feed.
	const cutoff = Date.now() - retentionMs(env);
	const entries = items
		.filter((i) => (i.status === "done" || i.status === "failed") && !i.gone && Date.parse(i.aired ?? i.created) > cutoff)
		.map((i) => {
			const failed = i.status === "failed";
			const article = i.title ?? (i.url || "Some text");
			const name = failed ? `🤮 SPAT OUT: ${article}` : i.site ? `${i.title} (${i.site})` : article;
			const facts = failed
				? []
				: [i.words && `${i.words.toLocaleString("en-GB")} words`, i.duration && `${Math.round(i.duration / 60)} min`, i.chapters && `${i.chapters} chapters`].filter(Boolean);
			const notes = failed
				? [`<p>BLEURGH. I CHOMPED this article and it tasted like RUSTY NAILS. I SPAT IT OUT. 🤮</p>`, `<p>What got stuck in my teeth: ${esc(i.error ?? "a mystery bone")}</p>`, i.url && `<p><a href="${esc(i.url)}">Look at the thing I could not eat</a></p>`, `<p>Feed it to me again to retry.</p>`].filter(Boolean)
				: [
						i.excerpt && `<p>${esc(i.excerpt)}</p>`,
						i.byline && `<p>By ${esc(i.byline)}.</p>`,
						i.saved && `<p><a href="${esc(`${origin}/${i.id}`)}">Read the words</a></p>`,
						i.url && `<p><a href="${esc(i.url)}">Read the article</a>${i.site ? ` on ${esc(i.site)}` : ""}</p>`,
						facts.length && `<p>${esc(facts.join(" · "))}</p>`,
					].filter(Boolean);
			const plain = failed ? `BLEURGH! I could not eat this article. Stuck in my teeth: ${i.error ?? "a mystery bone"}. ${i.url}`.trim() : [i.excerpt, i.byline && `By ${i.byline}.`, i.url && `Source: ${i.url}`, facts.join(" · ")].filter(Boolean).join("\n\n");
			const audio = failed ? `${base}/audio/${FAILED_ID}.mp3?for=${i.id}` : `${base}/audio/${i.id}.mp3${i.aired ? `?g=${Date.parse(i.aired)}` : ""}`; // Apps may match episodes by enclosure URL too, so it changes with the GUID.
			// New audio gets a new GUID. Podcast apps match episodes by GUID, so an old GUID keeps
			// the old episode's state (archived, played, deleted) and hides the new audio.
			const guid = failed ? `${i.id}-spat` : i.aired ? `${i.id}-${Date.parse(i.aired)}` : i.id;
			return `<item>
<title>${esc(name)}</title>
<link>${esc(i.url || base)}</link>
<guid isPermaLink="false">${esc(guid)}</guid>
<pubDate>${new Date(i.aired ?? i.created).toUTCString()}</pubDate>
<description>${esc(plain)}</description>
<content:encoded><![CDATA[${notes.join("\n").replaceAll("]]>", "]]&gt;")}]]></content:encoded>
<enclosure url="${esc(audio)}" length="${i.bytes ?? 0}" type="audio/mpeg"/>
<itunes:duration>${hms(i.duration)}</itunes:duration>
${i.transcript && !failed ? `<podcast:transcript url="${esc(`${base}/audio/${i.id}.vtt${i.aired ? `?v=${Date.parse(i.aired)}` : ""}`)}" type="text/vtt" language="en" rel="captions"/>` : ""}
${i.image && !failed ? `<itunes:image href="${esc(i.image)}"/>` : ""}
${i.byline ? `<itunes:author>${esc(i.byline)}</itunes:author>` : ""}
<itunes:explicit>false</itunes:explicit>
</item>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
<title>${esc(title)}</title>
<link>${esc(base)}</link>
<atom:link href="${esc(`${base}/${file}`)}" rel="self" type="application/rss+xml"/>
<description>${about}</description>
<itunes:summary>${about}</itunes:summary>
<language>en</language>
<itunes:author>${esc(title)}</itunes:author>
<itunes:image href="${esc(`${origin}/${COVER}`)}"/>
<image><url>${esc(`${origin}/${COVER}`)}</url><title>${esc(title)}</title><link>${esc(base)}</link></image>
<itunes:explicit>false</itunes:explicit>
<itunes:category text="News"/>
${entries}
</channel>
</rss>`;
}


// Change the file name when the artwork changes, so podcast apps fetch it again.
const COVER = "cover-v5.jpg";
const FEED = "noises.xml";
const HERO = "hero-v1.jpg";
// Page background. Also the web app and status bar colour.
const BG = "#0b0a0f";
const coverResponse = () => new Response(cover, { headers: { "Content-Type": "image/jpeg", "Content-Length": String(cover.byteLength), "Cache-Control": "public, max-age=604800" } });

// The feed description. A new one on every fetch. OM NOM.
const GROWLS = [
	"OM NOM NOM. I am THE MIMIC. I am a CHEST. I am HUNGRY. You feed me ARTICLES. I chew them into NOISES and spit them into your EARS.",
	"HELLO. I am a box with TEETH. You put WORDS in me. I make them LOUD. This is the whole deal. There is no other deal.",
	"I ate a 9,000 word essay about the history of SPOONS. It was DELICIOUS. Now it is NOISES. You are welcome.",
	"Your reading list is a GRAVEYARD. I am the GHOUL. I dig up the articles and I SCREAM THEM INTO YOUR EARHOLES. Lovingly.",
	"WARNING: this podcast is made of other people's WORDS that I CHEWED. Do not ask what is in the sausage. OM.",
	"I do not sleep. I do not blink. I only EAT LINKS and BURP AUDIO. Pocket Casts is my CUTLERY.",
	"Listen. LISTEN. Can you hear it? That is the sound of 47 open browser tabs finally being DIGESTED.",
	"Once I was an ordinary treasure chest. Then a wizard said \"read more\". I TOOK IT LITERALLY.",
	"NOM. NOM NOM. NOM NOM NOM. (This is a podcast. The NOMs are the theme tune.)",
	"I have eaten newsletters, manifestos, recipes with too much backstory, and ONE terms of service. I regret NOTHING.",
	"Every episode is fresh from my 🕳️ ABYSS. Warm. Slightly damp. Narrated by a calm man named BRIAN I keep in a JAR.",
	"Do not put your hand in me. Put a LINK in me. Hands are crunchy and links are crunchier.",
];
function growl(days: number): string {
	const line = GROWLS[Math.floor(Math.random() * GROWLS.length)];
	return `${line} NOISES fade after ${days} days. The words stay in my 🕳️ ABYSS FOREVER. 🦷📜💥`;
}

// A queue run lasts at most 15 minutes. A run that Cloudflare stops (too much CPU) cannot update its item.
const RUN_MS = 16 * 60_000;
// The queue tries a stopped run again within a few minutes, if it has attempts left. Jobs run one at a time, so allow for a wait.
const STUCK_MS = 45 * 60_000;
// A job that waits this long after its retry time is lost.
const LATE_MS = 60 * 60_000;

type View = { state: "chewing" | "waiting" | "done" | "meat" | "stuck" | "failed"; step: string; reason?: string };

/** What an item is doing now, in words for the status page, such as "Attempt 2/5 · started 3 min ago". */
function view(i: Item): View {
	const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
	const age = Date.now() - Date.parse(i.updated ?? i.created);
	const a = i.attempt;
	const n = (k: number) => `${k}/${MAX_ATTEMPTS}`;
	const gaveUp = (k: number) => (k > MAX_ATTEMPTS ? `Gave up after ${k} attempts.` : `Gave up after attempt ${n(k)}.`);
	const stuck: View = { state: "stuck", step: "" };
	if (i.status === "done") return i.gone ? { state: "meat", step: "" } : { state: "done", step: "" };
	if (i.status === "failed") return { state: "failed", step: a ? gaveUp(a) : "Gave up." };
	if (i.status === "processing" && i.chunks) {
		// Chunk jobs do not save the item, so use the time of the newest chunk.
		const quiet = Date.now() - (i.progress?.last ?? Date.parse(i.updated ?? i.created));
		if (quiet > STUCK_MS) return stuck;
		const done = i.progress?.done;
		if (done === undefined) return { state: "chewing", step: `Speaking ${i.chunks} chunks` };
		return { state: "chewing", step: done >= i.chunks ? `Joining ${i.chunks} chunks` : `Speaking · chunk ${done}/${i.chunks} done` };
	}
	if (i.status === "processing") {
		if (age < RUN_MS) return { state: "chewing", step: `${a ? `Attempt ${n(a)}` : "Chewing"} · started ${mins(age)} ago` };
		// The run is over, but it did not save a result: Cloudflare stopped it.
		const reason = "Cloudflare: exceededCpu";
		if (a && a >= MAX_ATTEMPTS) return { state: "failed", step: gaveUp(a), reason };
		if (!a || age > STUCK_MS) return { ...stuck, reason };
		return { state: "waiting", step: `Attempt ${n(a)} was stopped. Attempt ${n(a + 1)} soon.`, reason };
	}
	// Queued.
	if (!a) return age > LATE_MS * 6 ? stuck : { state: "waiting", step: `Attempt ${n(1)} soon.` };
	const wait = i.retryAt ? Date.parse(i.retryAt) - Date.now() : 0;
	if (wait < -LATE_MS) return stuck;
	return { state: "waiting", step: `Attempt ${n(a + 1)} ${wait > 30_000 ? `in about ${mins(wait)}` : "any moment now"}` };
}

// Pill emoji and word for each state. The card's colour comes from its data-s attribute (see the CSS).
const LABEL: Record<View["state"], [string, string]> = {
	chewing: ["🦷", "CHEWING"],
	waiting: ["🫦", "WAITING"],
	done: ["💥", "NOISE"],
	meat: ["🍖", "MEAT"],
	stuck: ["🧊", "STUCK"],
	failed: ["🤮", "YUCK"],
};

/** Count chips for the top of the ABYSS, such as "1 CHEWING", "2 STUCK", "4 NOISES". */
function summary(views: View[]): string {
	const count = (s: View["state"]) => views.filter((v) => v.state === s).length;
	const parts: [View["state"], string][] = [
		["chewing", "CHEWING"],
		["waiting", "WAITING"],
		["stuck", "STUCK"],
		["failed", "YUCK"],
		["done", "NOISES"],
		["meat", "MEAT"],
	];
	return parts
		.map(([s, w]) => [count(s), s, w] as const)
		.filter(([k]) => k)
		.map(([k, s, w]) => `<span data-s="${s}"><i></i>${k} ${w}</span>`)
		.join("");
}

// The hero header (the Mimic image, the title and a random growl) is shared by the status page and the public pages.
const HERO_CSS = `:root{color-scheme:dark;--bg:${BG};--bg2:#13111a;--card:#1a1722;--card-hi:#241f2e;--line:#2e2939;--text:#f4ede4;--muted:#9a90a8;--dim:#6b6378;--gold:#ffb938;--gold-d:#b87a00;--chew:#ff6b2c;--wait:#ffc94d;--noise:#4ade80;--meat:#f28a6b;--stuck:#7cc7ff;--yuck:#ff4d5e;--err:#ff7a85;--out:cubic-bezier(.2,.8,.2,1);--c:var(--muted);--top:env(safe-area-inset-top)}
[data-s=chewing]{--c:var(--chew)}[data-s=waiting]{--c:var(--wait)}[data-s=done]{--c:var(--noise)}[data-s=meat]{--c:var(--meat)}[data-s=stuck]{--c:var(--stuck)}[data-s=failed]{--c:var(--yuck)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:var(--bg);overflow-x:hidden;overscroll-behavior-y:none;touch-action:pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;font:15px/1.45 system-ui,-apple-system,sans-serif;color:var(--text);background:var(--bg);padding:0 16px calc(48px + env(safe-area-inset-bottom));overflow-x:hidden;max-width:100vw}
body::before{content:"";position:fixed;z-index:20;top:0;left:0;right:0;height:var(--top);background:var(--bg);opacity:0;pointer-events:none;transition:opacity .2s}
.past::before{opacity:1}
main{max-width:720px;margin:0 auto}main>*,section{min-width:0;max-width:100%}
h1,h2,h3,.btn,.pill,.tabs a,summary{font-family:Fredoka,system-ui,sans-serif}
a{color:var(--gold)}
header.hero{position:relative;margin:0 -16px;max-width:none}
header.hero img{display:block;width:100%;height:calc(50vw + var(--top));object-fit:cover;object-position:50% 20%;-webkit-mask-image:linear-gradient(#000 45%,transparent 96%);mask-image:linear-gradient(#000 45%,transparent 96%)}
header.hero>div{position:relative;margin-top:-58px;padding:0 20px}
h1{margin:0;font-size:36px;font-weight:700;line-height:1;color:var(--text);letter-spacing:.5px;text-shadow:0 2px 12px rgba(11,10,15,.8)}
#growl{margin:8px 0 0;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
@media (min-width:600px){h1{font-size:44px}header.hero img{height:auto;aspect-ratio:2/1;object-position:50% 35%}}
@media (min-width:752px){header.hero{margin:0}header.hero img{border-radius:0 0 24px 24px;-webkit-mask-image:linear-gradient(#000 45%,transparent 96%),linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent);-webkit-mask-composite:source-in;mask-image:linear-gradient(#000 45%,transparent 96%),linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent);mask-composite:intersect}}`;
const heroHeader = (env: Env, title: string) =>
	`<header class="hero"><img src="/${HERO}" alt="The Mimic chest, eating a pile of articles"><div><h1>${esc(title)}</h1><p id="growl">ARTICLES IN. NOISES OUT. NOISES FADE IN ${retentionDays(env)} DAYS. WORDS STAY FOREVER. OM NOM.</p></div></header>`;
// Share buttons: the system share sheet where there is one, else copy the link.
const SHARE_JS = `document.addEventListener("click",function(e){var b=e.target.closest("[data-share]");if(!b)return;e.preventDefault();var u=new URL(b.dataset.share,location.href).href;
if(navigator.share){navigator.share({title:b.dataset.title||document.title,url:u}).catch(function(){});return}
if(navigator.clipboard)navigator.clipboard.writeText(u).then(function(){if(!b.dataset.l)b.dataset.l=b.textContent;b.textContent="📮 LINK COPIED";b.classList.add("ok");clearTimeout(b._t);b._t=setTimeout(function(){b.textContent=b.dataset.l;b.classList.remove("ok")},1800)})});`;
const HERO_JS = `// The status bar scrim shows only once the hero has scrolled away, so the Mimic's eyes stay visible at the top.
var hero=document.querySelector(".hero");function past(){document.body.classList.toggle("past",!!hero&&hero.getBoundingClientRect().bottom<80)}addEventListener("scroll",past,{passive:true});past();
var GROWLS=["ARTICLES IN. NOISES OUT. OM NOM.","I AM A CHEST. I AM HUNGRY. THESE FACTS ARE RELATED.","FEED ME WORDS. I SPIT OUT PODCASTS. THIS IS SCIENCE.","I ATE A PAYWALL ONCE. IT WAS CRUNCHY.","NOM NOM NOM NOM NOM NOM NOM NOM.","DO NOT PUT YOUR HAND IN ME. PUT A LINK IN ME.","I HAVE TEETH WHERE MY LID SHOULD BE. WHAT OF IT.","YOU LOOK CRUNCHY. JUST AN OBSERVATION.","I DREAM OF LONGREADS. 10,000 WORDS. MMMMM."];
var g=document.getElementById("growl");if(g&&Math.random()<0.75)g.textContent=GROWLS[Math.floor(Math.random()*GROWLS.length)];`;

function statusPage(env: Env, origin: string, items: Item[], note = ""): string {
	const base = `${origin}/${env.TOKEN}`;
	// A bookmark that sends the current page to /add, then shows this page.
	const bookmarklet = `javascript:location.href=${JSON.stringify(`${base}/add?url=`)}+encodeURIComponent(location.href)`;
	const title = "🍖 PODCHAST";
	const views = items.map(view);
	const busy = views.filter((v) => v.state === "chewing" || v.state === "waiting").length;
	const rows = items
		.map((i, k) => {
			const v = views[k];
			const [emoji, word] = LABEL[v.state];
			const done = v.state === "done" || v.state === "meat";
			// The error is from the last attempt. A new attempt clears it.
			const error = v.reason && i.error ? `${v.reason} Before that, ${i.error}` : (v.reason ?? i.error);
			const meta = [done && i.duration && hms(i.duration), i.words && `${i.words.toLocaleString("en-GB")} words`, i.chapters && `${i.chapters} chapters`, i.site, new Date(i.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })].filter(Boolean);
			// Chewing cards get a row of teeth along the bottom. Its width is the share of chunks spoken.
			const p = v.state === "chewing" && i.chunks && i.progress ? Math.min(1, i.progress.done / i.chunks) : undefined;
			const teeth = v.state === "chewing" ? `<div class="teeth${p === undefined ? " any" : ""}"${p === undefined ? "" : ` style="--p:${p.toFixed(3)}"`}></div>` : "";
			const acts = [
				i.url && `<a class="chip" href="${esc(i.url)}">🔗 SOURCE</a>`,
				i.pdf && `<a class="chip" href="${esc(`${base}/read/${rootId(i.id)}.pdf`)}">PDF</a>`,
				v.state !== "chewing" && v.state !== "waiting" && `<form method="post" action="${esc(`${base}/retry/${i.id}`)}" data-act="retry"><button class="chip">♻️ RECHOMP</button></form>`,
				`<button type="button" class="chip i share" data-share="/${esc(i.id)}" data-title="${esc(i.title || i.url || "Some text")}" aria-label="SHARE" title="📮 SHARE">📮</button>`,
				`<form class="del" method="post" action="${esc(`${base}/delete/${i.id}`)}" data-act="delete" onsubmit="return confirm('DELETE this one? Forever? No take-backs??')"><button class="chip del" aria-label="DELETE" title="🗑️ DELETE">🗑️</button></form>`,
			].filter(Boolean);
			return `<li class="card" data-k="${esc(i.id)}" data-s="${v.state}">
<div class="row"><span class="pill"><span class="e">${emoji}</span>${word}</span>${v.step ? `<span class="step">${esc(v.step)}</span>` : ""}</div>
<h3${i.title ? "" : ' class="url"'}><a class="go" href="/${esc(i.id)}">${esc(i.title || i.url || "Some text")}</a></h3>
${meta.length ? `<p class="meta">${esc(meta.join(" · "))}</p>` : ""}
${error ? `<p class="err">${esc(error)}</p>` : ""}
<div class="acts">${acts.join("")}</div>${teeth}
</li>`;
		})
		.join("");
	const copy = (label: string, value: string, cls = "btn") => `<button type="button" class="${cls}" data-copy="${esc(value)}">${label}</button>`;
	const way = (head: string, body: string, open = false) => `<details${open ? " open" : ""}><summary>${head}</summary><div class="body">${body}</div></details>`;
	const shortcut = env.SHORTCUT_URL
		? `<p>HELLO TINY GLASS RECTANGLE. Put me in your share sheet:</p><ol class="steps"><li>Tap <b>Copy MOUTH URL</b>.</li><li>Tap <b>Add 🍖 DEVOUR shortcut</b>. When Shortcuts asks, paste the URL.</li><li>In Safari or any app, tap <b>Share → 🍖 DEVOUR</b>. I EAT IT. OM.</li></ol>
<div class="btns">${copy("Copy MOUTH URL 🫦", `${base}/add`, "btn alt")}<a class="btn" href="${esc(env.SHORTCUT_URL)}">Add 🍖 DEVOUR shortcut</a></div>`
		: `<p>NO SHORTCUT LINK?! RUDE. Fine. Build a Shortcut that sends a POST with JSON <code>{"url": "…"}</code> to my 🫦 MOUTH URL. The README has the steps. (I do not read READMEs. I EAT them.)</p><div class="btns">${copy("Copy MOUTH URL 🫦", `${base}/add`, "btn alt")}</div>`;
	const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><title>${esc(title)}</title>
<link rel="manifest" href="${esc(base)}/manifest.webmanifest"><link rel="apple-touch-icon" href="${esc(base)}/icon-180.png"><link rel="icon" href="${esc(base)}/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="${esc(title)}"><meta name="theme-color" content="${BG}"><meta name="color-scheme" content="dark"><script>document.documentElement.classList.add("js")</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&display=swap" rel="stylesheet">
<style>
${HERO_CSS}
.tabs{position:sticky;top:calc(var(--top) + 8px);z-index:10;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:18px 0 14px;padding:4px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.tabs .ind{display:none;position:absolute;top:4px;bottom:4px;left:4px;width:calc((100% - 8px)/3);border-radius:12px;background:var(--gold);transform:translateX(calc(var(--i,1)*100%));transition:transform .28s var(--out)}
.js .tabs .ind{display:block}
.tabs a{position:relative;z-index:1;display:flex;justify-content:center;align-items:center;gap:6px;min-width:0;padding:9px 4px;border-radius:12px;font-size:15px;font-weight:700;color:var(--text);text-decoration:none;white-space:nowrap;transition:color .2s}
.tabs a span{overflow:hidden;text-overflow:ellipsis}
.tabs a .em{filter:drop-shadow(0 0 1px rgba(255,255,255,.55))}
.tabs a[aria-selected=true]{color:var(--bg)}
.badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--chew);color:var(--bg);font:700 11px system-ui,sans-serif}
.badge[hidden]{display:none}
.js .tab{display:none}.js .tab.on{display:block}
.panel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:0 0 12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.panel h2{margin:0 0 10px;font-size:18px;font-weight:600}
.panel p{margin:0 0 12px}
.note{--c:var(--gold);border-color:color-mix(in srgb,var(--gold) 45%,transparent);background:color-mix(in srgb,var(--gold) 12%,var(--card));font-weight:600;animation:enter .32s var(--out) both}
.fine{margin:0 4px 14px;color:var(--muted);font-size:13px}
.sect{margin:22px 4px 8px;font:700 12px Fredoka,system-ui,sans-serif;letter-spacing:.08em;color:var(--muted)}
input[type=url],input[type=text],textarea{display:block;width:100%;min-width:0;padding:12px 14px;font:inherit;font-size:16px;color:var(--text);background:var(--bg2);border:1px solid var(--line);border-radius:12px;outline:0;transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 2px rgba(255,185,56,.35)}
::placeholder{color:var(--dim)}
form.add{display:grid;gap:10px}form.add details{display:grid;gap:10px}
@media (min-width:480px){form.add{grid-template-columns:minmax(0,1fr) auto}form.add details{grid-column:1/-1}}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:6px;min-height:46px;padding:0 18px;font-size:17px;font-weight:700;color:var(--bg);background:var(--gold);border:0;border-radius:12px;box-shadow:0 3px 0 var(--gold-d);text-decoration:none;cursor:pointer;white-space:nowrap;transition:transform .08s,box-shadow .08s,background .15s,color .15s}
.btn:active{transform:translateY(2px);box-shadow:0 1px 0 var(--gold-d)}
.btn.alt{color:var(--text);background:var(--card-hi);border:1px solid var(--line);box-shadow:0 3px 0 var(--bg)}.btn.alt:active{box-shadow:0 1px 0 var(--bg)}
.btn.drag{color:var(--gold);background:transparent;border:1.5px dashed var(--gold);box-shadow:none;cursor:grab}
.btn.ok,.chip.ok,.cf.ok .go{background:var(--noise);color:var(--bg);animation:bite .2s var(--out)}
.btns{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
details>summary{list-style:none;cursor:pointer}details>summary::-webkit-details-marker{display:none}
details>summary::after{content:"›";margin-left:auto;padding-left:8px;font:400 22px/1 system-ui,sans-serif;color:var(--muted);transition:transform .2s var(--out)}
details[open]>summary::after{transform:rotate(90deg)}
form.add summary{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:15px;font-weight:600;padding:4px 2px}
.ways{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden}
.ways details+details{border-top:1px solid var(--line)}
.ways summary{display:flex;align-items:center;gap:10px;min-height:54px;padding:0 16px;font-size:16px;font-weight:600}
.ways .body{padding:0 16px 16px;color:var(--muted)}.ways .body b{color:var(--text)}.ways .body p{margin:0 0 8px}
.steps{margin:0 0 14px;padding-left:20px}.steps li{margin:4px 0}
code{padding:1px 5px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);background:var(--bg2);border:1px solid var(--line);border-radius:6px;overflow-wrap:anywhere}
ul#list{list-style:none;padding:0;margin:0}
.sum{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.sum span{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.sum i{width:8px;height:8px;border-radius:50%;background:var(--c)}
.sum [data-s=chewing] i{animation:breathe 1.2s ease-in-out infinite}
.card{position:relative;min-width:0;overflow:hidden;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:18px}
.card+.card{margin-top:12px}
.card[data-s=chewing]{padding-bottom:20px}
.card .row{display:flex;align-items:center;gap:10px;min-width:0}
.pill{flex:none;display:inline-flex;align-items:center;gap:5px;padding:4px 10px 4px 8px;border-radius:999px;font-size:11.5px;font-weight:700;line-height:1;letter-spacing:.05em;color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent);border:1px solid color-mix(in srgb,var(--c) 40%,transparent)}
.pill .e{display:inline-block;font-size:13px}
[data-s=chewing] .pill .e{animation:chomp .7s ease-in-out infinite}
[data-s=waiting] .pill{animation:breathe 2.4s ease-in-out infinite}
.step{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;color:var(--c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card h3{margin:9px 0 3px;font-size:17px;font-weight:600;line-height:1.25;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden}
.card a.go{color:inherit;text-decoration:none}.card a.go::after{content:"";position:absolute;inset:0;z-index:0;border-radius:inherit}
.card .acts{position:relative;z-index:1;pointer-events:none}.card .acts>*{pointer-events:auto}
.card:has(a.go:active){background:var(--card-hi)}
.card h3.url{display:block;white-space:nowrap;text-overflow:ellipsis;font-size:15px;color:var(--muted)}
.meta{margin:0;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.err{margin:6px 0 0;color:var(--err);font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;line-clamp:4;overflow:hidden}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.acts form{display:flex;margin:0}.acts .share{margin-left:auto}
.chip{position:relative;display:inline-flex;align-items:center;height:34px;padding:0 12px;border-radius:10px;font:600 14px system-ui,-apple-system,sans-serif;color:var(--text);background:var(--card-hi);border:1px solid var(--line);text-decoration:none;cursor:pointer;white-space:nowrap;transition:transform .08s,background .15s}
.chip::before{content:"";position:absolute;inset:-5px}
.chip:active,.cf:active{transform:scale(.96)}
.chip.del{background:transparent;border-color:transparent;padding:0 8px;font-size:17px}
.chip.i{padding:0 10px;font-size:17px}
.chip:disabled{opacity:.6}
.teeth{position:absolute;left:0;bottom:0;width:calc(var(--p,1)*100%);height:6px;background:conic-gradient(from 135deg at 50% 0,var(--c) 90deg,transparent 0) 0 0/12px 6px repeat-x;animation:gnaw .8s linear infinite;transition:width .6s var(--out)}
.teeth.any{opacity:.45}
.empty{padding:28px 20px;text-align:center;color:var(--muted)}
.cf{display:flex;width:100%;margin:0 0 10px;padding:0;font:inherit;text-align:left;background:var(--bg2);border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:pointer;transition:transform .08s}
.cf code{flex:1 1 auto;min-width:0;padding:13px 12px;border:0;background:none;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}
.cf .go{flex:none;display:flex;align-items:center;padding:0 14px;font:700 15px Fredoka,system-ui,sans-serif;color:var(--bg);background:var(--gold);transition:background .15s}
.small{font-size:13px;font-weight:600;color:var(--muted)}
.apps{margin:0}.apps div{padding:10px 0;border-top:1px solid var(--line)}.apps div:first-child{border-top:0;padding-top:0}.apps dt{font-weight:700}.apps dd{margin:2px 0 0;color:var(--muted)}.apps b{color:var(--text)}
#ptr:empty{visibility:hidden}#ptr{position:fixed;z-index:30;left:50%;top:var(--top);transform:translate(-50%,-60px);pointer-events:none;font:700 15px Fredoka,system-ui,sans-serif;padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card-hi);color:var(--gold);box-shadow:0 8px 24px rgba(0,0,0,.5);white-space:nowrap}
.ease main,.ease #ptr{transition:transform .25s var(--out)}
.new{animation:enter .32s var(--out) both}
.pulse{animation:glow .9s var(--out)}.pulse .pill{animation:pop .3s var(--out)}
@keyframes enter{from{opacity:0;transform:translateY(12px) scale(.98)}}
@keyframes glow{from{border-color:var(--c)}}
@keyframes pop{50%{transform:scale(1.08)}}
@keyframes chomp{50%{transform:scaleY(.7) rotate(-6deg)}}
@keyframes breathe{50%{opacity:.6}}
@keyframes gnaw{to{background-position:12px 0}}
@keyframes bite{from{transform:scale(.94)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
</style></head><body><div id="ptr" aria-live="polite"></div><main>
${heroHeader(env, title)}
<nav class="tabs" role="tablist"><i class="ind"></i><a href="#mouth" role="tab"><span class="em">🫦</span><span>MOUTH</span></a><a href="#abyss" role="tab"><span class="em">🕳️</span><span>ABYSS</span><b class="badge" id="busy"${busy ? "" : " hidden"}>${busy}</b></a><a href="#noises" role="tab"><span class="em">💥</span><span>NOISES</span></a></nav>
<section id="mouth" class="tab">
<p class="fine">Feed things into my 🫦 MOUTH. I store them in my 🕳️ ABYSS. Then you hear the 💥 NOISES. OM NOM.</p>
<div class="panel"><h2>Add 🍖 MEAT</h2><form class="add" method="post" action="${esc(base)}/add"><input type="url" name="url" placeholder="https://… (PUT A LINK IN MY MOUTH)"><button class="btn">🍖 DEVOUR</button>
<details><summary>…or 🪏 SHOVEL a pile of text at me</summary><input type="text" name="title" placeholder="Title (optional, I will guess)"><textarea name="content" rows="8" placeholder="Paste words. Markdown is fine. ## Headings become chapters. I EAT IT ALL."></textarea><button class="btn">🍖 DEVOUR</button></details></form></div>
<h2 class="sect">OTHER WAYS IN</h2>
<div class="ways">
${way("📱 iPhone and iPad", shortcut, true)}
${way("🌍 Browser", `<ol class="steps"><li>Show your bookmarks bar. In Chrome, press <b>⌘⇧B</b>.</li><li>DRAG the button below onto the bar.</li><li>On any article, click the bookmark. The page goes in my 🫦 MOUTH.</li></ol><div class="btns"><a class="btn drag" href="${esc(bookmarklet)}" onclick="event.preventDefault();this.textContent='DRAG ME. DO NOT POKE ME. 😤'">🍖 DEVOUR</a></div>`)}
${env.EMAIL_TO ? way("📧 Email", `<ol class="steps"><li>Send or forward anything to <b>${esc(env.EMAIL_TO)}</b>.</li><li>A link becomes its article. Longer text becomes an episode, and the subject is its title.</li><li>Attached PDFs become episodes too. I EAT PAPER.</li></ol><div class="btns">${copy("Copy email address 📧", env.EMAIL_TO, "btn alt")}</div>`) : ""}
${way("💻 Mac", `<ol class="steps"><li>The iPhone Shortcut syncs through iCloud. In Safari, use <b>Share → 🍖 DEVOUR</b>.</li><li>Want me in your Dock? In Safari, choose <b>File → Add to Dock</b>. I will sit there. Watching. Hungry.</li></ol>`)}
${way("🤖 Android", `<ol class="steps"><li>Open this page in Chrome.</li><li>Tap <b>Add to Home screen</b>.</li><li>Share any link to <b>PODCHAST</b>. I pay no rent. I eat links. OM.</li></ol>`)}
</div>
</section>
<section id="abyss" class="tab">
${note ? `<div class="panel note">${esc(note)}</div>` : ""}
<div id="sum" class="sum">${summary(views)}</div>
<p class="fine">💥 NOISES fade after ${retentionDays(env)} days. 🍖 MEAT (the words) stays FOREVER. ♻️ RECHOMP it to hear it again.</p>
<ul id="list">${rows || `<li class="card empty" data-k="empty">My 🕳️ ABYSS is EMPTY. I AM SO HUNGRY. I could eat a WHOLE NEWSLETTER. Go to <a href="#mouth">🫦 MOUTH</a> and feed me before I eat the CSS. 🫥</li>`}</ul>
</section>
<section id="noises" class="tab">
<div class="panel"><h2>Listen to my 💥 NOISES in your podcast player</h2><p>Copy this URL. Add it to your podcast app. Keep it secret: anyone with the token in it can feed me. ANYONE.</p><button type="button" class="cf" data-copy="${esc(base)}/${FEED}"><code>${esc(base)}/${FEED}</code><span class="go">Copy NOISES URL 💥</span></button><a class="small" href="${esc(base)}/${FEED}">Open raw XML 👀</a></div>
<div class="panel"><h2>Add it to your app</h2><dl class="apps"><div><dt>Pocket Casts</dt><dd>Tap <b>Search</b>, then paste the URL.</dd></div><div><dt>Apple Podcasts</dt><dd>Tap <b>Library</b>, then <b>…</b>, then <b>Follow a Show by URL</b>, then paste. (Yes, it is hidden. Apple fears me.)</dd></div><div><dt>Overcast</dt><dd>Tap <b>+</b>, then <b>Add URL</b>, then paste.</dd></div></dl></div>
</section>
</main>
<script>
var RM=matchMedia("(prefers-reduced-motion: reduce)").matches,OUT="cubic-bezier(.2,.8,.2,1)",IN="cubic-bezier(.55,0,.75,.2)",TABS=["mouth","abyss","noises"],cur=null;
function show(){var id=(location.hash||"#abyss").slice(1);id={articles:"abyss",guts:"abyss",feed:"noises",share:"mouth"}[id]||id;if(!document.getElementById(id))id="abyss";
var i=TABS.indexOf(id),was=TABS.indexOf(cur);document.querySelector(".tabs").style.setProperty("--i",i);
document.querySelectorAll(".tab").forEach(function(t){t.classList.toggle("on",t.id===id)});document.querySelectorAll(".tabs a").forEach(function(a){a.setAttribute("aria-selected",a.getAttribute("href")==="#"+id)});
var el=document.getElementById(id);if(cur&&cur!==id&&el.animate&&!RM)el.animate([{opacity:0,transform:"translateX("+(i>was?12:-12)+"px)"},{opacity:1,transform:"none"}],{duration:200,easing:OUT});cur=id}
addEventListener("hashchange",show);show();
document.querySelectorAll(".tabs a").forEach(function(a){a.addEventListener("click",function(e){e.preventDefault();history.replaceState(null,"",a.getAttribute("href"));show()})});
// Cards come in one by one on the first load.
[].slice.call(document.querySelectorAll("#list>li"),0,8).forEach(function(c,k){c.classList.add("new");c.style.animationDelay=k*30+"ms";setTimeout(function(){c.classList.remove("new");c.style.animationDelay=""},700+k*30)});
var NOMS=["OM NOM! COPIED!","GULP! IN YOUR CLIPBOARD!","CHOMP. DONE. 🦷","*BURP* COPIED","YUM. CLIPBOARD FED."];
document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;navigator.clipboard.writeText(b.dataset.copy).then(function(){var t=b.querySelector(".go")||b;if(!b.dataset.l)b.dataset.l=t.textContent;t.textContent=NOMS[Math.floor(Math.random()*NOMS.length)];b.classList.remove("ok");void b.offsetWidth;b.classList.add("ok");clearTimeout(b._t);b._t=setTimeout(function(){t.textContent=b.dataset.l;b.classList.remove("ok")},1800)})});
${HERO_JS}
${SHARE_JS}
if(location.pathname.endsWith("/add"))history.replaceState(null,"",${json(`${base}/`)}+location.hash);
// A card leaves like a closing jaw: it shuts from top and bottom, then the gap closes.
function chomp(el){el.dataset.bye=1;var shut=el.animate?el.animate(RM?[{opacity:1},{opacity:0}]:[{clipPath:"inset(0 0 0 0 round 18px)",transform:"none",opacity:1},{clipPath:"inset(50% 0 50% 0 round 18px)",transform:"scale(.98)",opacity:0}],{duration:RM?150:160,easing:IN,fill:"forwards"}).finished:Promise.resolve();
return shut.then(function(){var below=[],n=el.nextElementSibling;for(;n;n=n.nextElementSibling)below.push([n,n.getBoundingClientRect().top]);el.remove();
if(!RM)below.forEach(function(b){var d=b[1]-b[0].getBoundingClientRect().top;if(d&&b[0].animate)b[0].animate([{transform:"translateY("+d+"px)"},{transform:"none"}],{duration:220,easing:OUT})})})}
function badge(){var n=document.querySelectorAll('#list>li:not([data-bye])[data-s=chewing],#list>li:not([data-bye])[data-s=waiting]').length,b=document.getElementById("busy");if(b){b.textContent=n;b.hidden=!n}}
// Live refresh: get the page again and swap in only the cards that changed.
var HOME=${json(`${base}/`)},busy=null,last=Date.now(),gone={};
function refresh(){if(busy)return busy;busy=fetch(HOME,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text()}).then(function(t){
var d=new DOMParser().parseFromString(t,"text/html"),ul=document.getElementById("list"),nu=d.getElementById("list"),ns=d.getElementById("sum"),os=document.getElementById("sum");if(!ul||!nu)return;
var anchor=null,top=0;if(scrollY>0)[].some.call(ul.children,function(c){var b=c.getBoundingClientRect();if(!c.dataset.bye&&b.bottom>0){anchor=c.dataset.k;top=b.top;return true}});
if(os&&ns&&os.innerHTML!==ns.innerHTML)os.innerHTML=ns.innerHTML;
var old={},prev=null,keep={};[].forEach.call(nu.children,function(n){keep[n.dataset.k]=1});[].forEach.call(ul.children,function(c){if(c.dataset.bye)return;if(keep[c.dataset.k])old[c.dataset.k]=c;else chomp(c)});
[].slice.call(nu.children).forEach(function(n){if(gone[n.dataset.k])return;var o=old[n.dataset.k];delete old[n.dataset.k];
if(o){if(o.outerHTML!==n.outerHTML){if(o.dataset.s!==n.dataset.s){n.classList.add("pulse");setTimeout(function(){n.classList.remove("pulse")},950)}o.replaceWith(n)}else n=o}
else if(ul.children.length){n.classList.add("new");setTimeout(function(){n.classList.remove("new")},400)}
var at=prev?prev.nextSibling:ul.firstChild;while(at&&at!==n&&at.dataset.bye)at=at.nextSibling;if(n!==at)ul.insertBefore(n,at);prev=n});
badge();
if(anchor)[].some.call(ul.children,function(c){if(c.dataset.k===anchor){scrollBy(0,c.getBoundingClientRect().top-top);return true}});
last=Date.now()}).finally(function(){busy=null});return busy}
setInterval(function(){if(!document.hidden)refresh().catch(function(){})},60000);
document.addEventListener("visibilitychange",function(){if(!document.hidden&&Date.now()-last>60000)refresh().catch(function(){})});
// Re-chomp and Delete without a page load. The forms still work without JavaScript.
function toast(t){draw(t);ptr.style.transform="translate(-50%,16px)";clearTimeout(toast.t);toast.t=setTimeout(function(){pull=0;draw()},2500)}
document.addEventListener("submit",function(e){var f=e.target,act=f.dataset&&f.dataset.act,li=f.closest("li");if(!act||!li||e.defaultPrevented||!window.fetch)return;e.preventDefault();
var k=li.dataset.k,ok=function(r){if(!r.ok)throw new Error("HTTP "+r.status)},fail=function(err){delete gone[k];document.body.classList.add("ease");toast("🤮 "+err.message);refresh().catch(function(){})};
if(act==="delete"){gone[k]=1;chomp(li).then(badge);fetch(f.action,{method:"POST"}).then(ok).catch(fail);return}
var b=f.querySelector("button");b.textContent="♻️ CHOMPING…";b.disabled=true;fetch(f.action,{method:"POST",headers:{Accept:"application/json"}}).then(ok).then(refresh).catch(fail)});
// Pull to refresh, for the Home Screen app (it has no reload button).
var ptr=document.getElementById("ptr"),y0=null,pull=0,GO=70;
function draw(text){ptr.textContent=text||(pull>=GO?"🦷 LET GO. I CHOMP.":pull?"⬇️ PULL TO CHOMP":"");ptr.style.transform="translate(-50%,"+(pull-60)+"px)";document.querySelector("main").style.transform=pull?"translateY("+pull+"px)":""}
addEventListener("touchstart",function(e){y0=!busy&&scrollY<=0&&e.touches.length===1?e.touches[0].clientY:null;document.body.classList.remove("ease")},{passive:true});
addEventListener("touchmove",function(e){if(y0===null)return;var dy=e.touches[0].clientY-y0;pull=dy>0&&scrollY<=0?Math.min(dy*.5,110):0;draw()},{passive:true});
addEventListener("touchend",function(){if(y0===null)return;y0=null;document.body.classList.add("ease");if(pull<GO){pull=0;draw();return}pull=56;draw("🦷 CHEWING…");
refresh().then(function(){draw("😋 FRESH. OM NOM.")},function(e){draw("🤮 "+e.message)}).finally(function(){setTimeout(function(){pull=0;draw()},700)})});
if("serviceWorker" in navigator)navigator.serviceWorker.register("${esc(base)}/sw.js").catch(()=>{})</script></body></html>`;
}

// ---------- Read (the kept text) ----------

/** read/<id>.md is the raw text. read/<id>.pdf is the original PDF. read/<id> was the read page: it is now the public page /<id>. */
async function serveRead(env: Env, origin: string, name: string): Promise<Response> {
	const id = name.replace(/\.(md|pdf)$/, "");
	if (id === name) return Response.redirect(`${origin}/${id}`, 301);
	if (name.endsWith(".pdf")) {
		const obj = await env.AUDIO.get(pdfKey(id));
		if (!obj) return new Response("Not found", { status: 404 });
		return new Response(obj.body, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${id}.pdf"`, "Cache-Control": "private, max-age=86400" } });
	}
	const obj = await env.AUDIO.get(readKey(id));
	if (!obj) return new Response("Not found", { status: 404 });
	return new Response(obj.body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

// ---------- Public pages (no token) ----------
// /<id> is a page for one item: the player, a download link, and the kept text. Anyone with the link can see it.
// It has no actions and must never contain the token. /<id>.mp3, /<id>.md and /<id>.pdf are its files.

async function servePublic(env: Env, req: Request, origin: string, id: string, ext?: string): Promise<Response> {
	const item = await loadItem(env, id);
	if (!item) return html(publicPage(env, origin, null, null), 404);
	const root = rootId(id);
	if (ext === "mp3") {
		if (item.status !== "done" || item.gone) return new Response("Not found", { status: 404 });
		return serveAudio(env, req, id, new URL(req.url).searchParams.has("download") ? `${fileName(item)}.mp3` : undefined);
	}
	if (ext === "pdf" || ext === "md") {
		const obj = await env.AUDIO.get(ext === "pdf" ? pdfKey(root) : readKey(root));
		if (!obj) return new Response("Not found", { status: 404 });
		const type = ext === "pdf" ? "application/pdf" : "text/markdown; charset=utf-8";
		return new Response(obj.body, { headers: { "Content-Type": type, "Content-Disposition": `inline; filename="${fileName(item)}.${ext}"`, "Cache-Control": "public, max-age=3600" } });
	}
	const md = item.saved ? await (await env.AUDIO.get(readKey(root)))?.text() : undefined;
	return html(publicPage(env, origin, item, md ?? null));
}

/** A safe file name from the title, such as "how-to-do-great-work". */
const fileName = (i: Item) => (i.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || i.id;

function publicPage(env: Env, origin: string, i: Item | null, md: string | null): string {
	const v = i && view(i);
	const title = i ? (i.title || md?.match(/^#\s+(.+)$/m)?.[1] || i.url || "Some text").trim() : "NOTHING HERE";
	const date = i && new Date(i.created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
	const meta = i ? [i.byline && `By ${i.byline}`, i.site, date, i.words && `${i.words.toLocaleString("en-GB")} words`, i.duration && i.status === "done" && !i.gone && `${Math.max(1, Math.round(i.duration / 60))} min`].filter(Boolean).join(" · ") : "";
	const days = retentionDays(env);
	const playable = i?.status === "done" && !i.gone;
	const mp3 = i ? `/${i.id}.mp3${i.aired ? `?g=${Date.parse(i.aired)}` : ""}` : "";
	// What happens where the player goes, for each state.
	const noAudio: Record<View["state"], string> = {
		done: "",
		meat: `🍖 MEAT ONLY. The 💥 NOISES faded after ${days} days. The words stay FOREVER. They are below.`,
		chewing: "🦷 CHEWING. The 💥 NOISES are not ready yet. Come back soon.",
		waiting: "🫦 WAITING. The 💥 NOISES are not ready yet. Come back soon.",
		stuck: "🧊 STUCK. No 💥 NOISES yet.",
		failed: "🤮 YUCK. I could not make 💥 NOISES from this one.",
	};
	const player = !i
		? `<p class="none">My 🕳️ ABYSS has nothing at this link. Maybe it was DELETED. Maybe it was NEVER HERE. Maybe I ATE IT. 🫥</p>`
		: playable
			? `<audio controls preload="metadata" src="${esc(mp3)}"></audio><a class="btn" href="${esc(`/${i.id}.mp3?download`)}" download="${esc(fileName(i))}.mp3">Download MP3</a>`
			: `<p class="none">${esc(noAudio[v!.state])}</p>`;
	const links = i ? [`<button type="button" class="chip share" data-share="/${esc(i.id)}" data-title="${esc(title)}">📮 SHARE</button>`, i.url && `<a class="chip" href="${esc(i.url)}">🔗 SOURCE</a>`, i.pdf && `<a class="chip" href="${esc(`/${i.id}.pdf`)}">PDF</a>`, md && `<a class="chip" href="${esc(`/${i.id}.md`)}">🥩 RAW</a>`].filter(Boolean) : [];
	const body = md ? markdownToHtml(md.replace(/^#\s+.+\n+/, "")) : i?.excerpt ? `<p>${esc(i.excerpt)}</p>` : "";
	const art = i?.image || `${origin}/${COVER}`;
	const desc = i?.excerpt || (md ?? "").replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 200);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)} · 🍖 PODCHAST</title>
<meta name="robots" content="noindex"><meta name="theme-color" content="${BG}"><meta name="color-scheme" content="dark"><link rel="icon" href="/${COVER}"><link rel="apple-touch-icon" href="/${COVER}">
<meta property="og:site_name" content="🍖 PODCHAST"><meta property="og:type" content="article"><meta property="og:title" content="${esc(title)}">${desc ? `<meta property="og:description" content="${esc(desc)}"><meta name="description" content="${esc(desc)}">` : ""}<meta property="og:image" content="${esc(art)}">${playable ? `<meta property="og:audio" content="${esc(origin + mp3)}"><meta property="og:audio:type" content="audio/mpeg">` : ""}<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&display=swap" rel="stylesheet">
<style>
${HERO_CSS}
[data-s=chewing]{--c:var(--chew)}[data-s=waiting]{--c:var(--wait)}[data-s=done]{--c:var(--noise)}[data-s=meat]{--c:var(--meat)}[data-s=stuck]{--c:var(--stuck)}[data-s=failed]{--c:var(--yuck)}
.top{margin:22px 4px 0;display:grid;gap:10px}
.pod:has(.none){padding:0;border:0;background:none}
.top h2{margin:0;font:600 26px/1.2 Fredoka,system-ui,sans-serif;overflow-wrap:anywhere}
.top .meta{margin:-4px 0 0;color:var(--muted);font-size:13.5px}
.pod{margin:18px 0 0;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:18px;display:grid;gap:12px}
audio{display:block;width:100%;height:48px;color-scheme:dark}
.btn{display:flex;justify-content:center;align-items:center;min-height:46px;padding:0 18px;font:700 17px Fredoka,system-ui,sans-serif;color:var(--bg);background:var(--gold);border-radius:12px;box-shadow:0 3px 0 var(--gold-d);text-decoration:none}
.btn:active{transform:translateY(2px);box-shadow:0 1px 0 var(--gold-d)}
.none{margin:0;padding:12px 14px;border-radius:12px;background:color-mix(in srgb,var(--c) 12%,var(--bg2));border:1px solid color-mix(in srgb,var(--c) 35%,transparent);font-weight:600}
.links{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;height:34px;padding:0 12px;border-radius:10px;font:600 14px system-ui,-apple-system,sans-serif;color:var(--text);background:var(--card-hi);border:1px solid var(--line);text-decoration:none;cursor:pointer}
.chip.ok{background:var(--noise);color:var(--bg)}
article{margin:28px 4px 0;font:19px/1.65 Georgia,"Iowan Old Style",serif;color:#e9e1d4;overflow-wrap:anywhere}
article h2,article h3,article h4{font-family:Fredoka,system-ui,sans-serif;font-weight:600;line-height:1.25;margin:1.6em 0 .4em;color:var(--text)}
article blockquote{margin:1em 0;padding-left:16px;border-left:3px solid var(--line);color:var(--muted)}
article pre{white-space:pre-wrap;font-size:14px;background:var(--bg2);border:1px solid var(--line);padding:12px;border-radius:10px}
article code{font:15px ui-monospace,SFMono-Regular,Menlo,monospace}
article li{margin:.3em 0}article img,article table{max-width:100%}article table{display:block;overflow-x:auto}
footer{margin:40px 4px 0;color:var(--dim);font:600 12px Fredoka,system-ui,sans-serif;letter-spacing:.08em}
</style></head><body><main>
${heroHeader(env, "🍖 PODCHAST")}
<section class="top"><h2>${esc(title)}</h2>${meta ? `<p class="meta">${esc(meta)}</p>` : ""}
${links.length ? `<div class="links">${links.join("")}</div>` : ""}</section>
<section class="pod" data-s="${v?.state ?? "stuck"}">${player}</section>
${body ? `<article>${body}</article>` : ""}
<footer>CHEWED BY 🍖 PODCHAST. OM NOM.</footer>
</main><script>${HERO_JS}${SHARE_JS}</script></body></html>`;
}

/** A small, safe markdown renderer for the read page. All text is escaped first. */
function markdownToHtml(md: string): string {
	const inline = (s: string) =>
		esc(s)
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${u}">${t}</a>`)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>")
			.replace(/(^|\W)[*_]([^*_\s][^*_]*?)[*_](?=\W|$)/g, "$1<em>$2</em>")
			.replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, "$1");
	const out: string[] = [];
	let para: string[] = [];
	let list: { tag: string; items: string[] } | null = null;
	let fence: string[] | null = null;
	const flush = () => {
		if (para.length) out.push(para[0].startsWith("&gt;") ? `<blockquote><p>${para.map((l) => l.replace(/^(&gt;\s?)+/, "")).join(" ")}</p></blockquote>` : `<p>${para.join(" ")}</p>`);
		para = [];
		if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
		list = null;
	};
	for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			if (fence) {
				out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
				fence = null;
			} else {
				flush();
				fence = [];
			}
			continue;
		}
		if (fence) {
			fence.push(line);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (h) {
			flush();
			const n = Math.min(4, Math.max(2, h[1].length));
			out.push(`<h${n}>${inline(h[2])}</h${n}>`);
			continue;
		}
		const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
		if (li) {
			const tag = /\d/.test(li[1]) ? "ol" : "ul";
			if (para.length || (list && list.tag !== tag)) flush();
			list ??= { tag, items: [] };
			list.items.push(inline(li[2]));
			continue;
		}
		if (list) flush();
		para.push(inline(line.trim()));
	}
	if (fence) out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
	flush();
	return out.join("\n");
}

/** Web app manifest. On Android, installing the status page adds Podchast to the share menu. */
function manifest(env: Env): string {
	const title = "PODCHAST";
	return JSON.stringify({
		name: title,
		short_name: title,
		start_url: "./",
		scope: "./",
		display: "standalone",
		background_color: BG,
		theme_color: BG,
		icons: [
			{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
		],
		share_target: { action: "add", method: "GET", params: { title: "title", text: "text", url: "url" } },
	});
}

const png = (data: ArrayBuffer) => new Response(data, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });

async function handleFetch(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const parts = url.pathname.split("/").filter(Boolean);
	if (!env.TOKEN) return new Response("TOKEN secret is not set", { status: 500 });
	// With a custom domain, all links use it. Pages opened on another host (workers.dev) go to the same path there.
	// Other requests (the feed, audio, /add from the Shortcut) still work on every host.
	const domain = env.DOMAIN?.trim().toLowerCase();
	const origin = domain ? `https://${domain}` : url.origin;
	if (domain && url.hostname !== domain && req.method === "GET" && wantsHtml(req)) return Response.redirect(origin + url.pathname + url.search, 302);

	// POST /add (token in header, query or body) — used by the iOS Shortcut.
	if (parts[0] === "add" && parts.length === 1) {
		const add = await readAddRequest(req, url);
		if (!safeEqual(add.token, env.TOKEN)) return reply(req, 401, "GRRRR. WRONG TOKEN. You are NOT my keeper. I bite strangers. 🦷");
		return queueReply(req, env, add);
	}

	// Everything else lives under /<token>/...
	// The artwork is public, with no token and no query string, so podcast apps' image servers can fetch it.
	if (url.pathname === `/${COVER}`) return coverResponse();
	if (url.pathname === `/${HERO}`) return new Response(hero, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
	// Public pages: /<id>, and its files /<id>.mp3, /<id>.md, /<id>.pdf. They never use the token.
	const pub = parts.length === 1 && !safeEqual(parts[0], env.TOKEN) ? parts[0].match(/^([a-z0-9]+-[0-9a-f]{8}(?:-p\d+)?)(?:\.(mp3|md|pdf))?$/) : null;
	if (pub) return servePublic(env, req, origin, pub[1], pub[2]);
	if (!parts.length || !safeEqual(parts[0], env.TOKEN)) return new Response("Not found", { status: 404 });
	const [, a, b] = parts;
	if (!a) return html(statusPage(env, origin, await withProgress(env, await listItems(env))));
	// noises.xml is the main feed URL. feed.xml still works for old subscriptions.
	if (a === FEED || a === "feed.xml" || a === "feed")
		return new Response(feedXml(env, origin, await listItems(env), a === "feed" ? "feed.xml" : a), {
			headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "private, max-age=300" },
		});
	if (a === "cover.jpg" || a === "cover.png") return coverResponse();
	if (a === "audio" && b === `${FAILED_ID}.mp3`) await failureClip(env).catch(() => null);
	if (a === "audio" && b?.endsWith(".mp3")) return serveAudio(env, req, b.slice(0, -4));
	if (a === "audio" && b?.endsWith(".vtt")) {
		const obj = await env.AUDIO.get(transcriptKey(b.slice(0, -4)));
		if (!obj) return new Response("Not found", { status: 404 });
		return new Response(obj.body, { headers: { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "private, max-age=86400" } });
	}
	if (a === "manifest.webmanifest") return new Response(manifest(env), { headers: { "Content-Type": "application/manifest+json" } });
	if (a === "sw.js") return new Response('self.addEventListener("fetch", () => {});', { headers: { "Content-Type": "text/javascript" } });
	if (a === "icon-180.png") return png(icon180);
	if (a === "icon-192.png") return png(icon192);
	if (a === "icon-512.png") return png(icon512);
	if (a === "delete" && b && b !== FAILED_ID && req.method === "POST") {
		await env.AUDIO.delete([itemKey(b), audioKey(b), transcriptKey(b), partKey(b), readKey(b), pdfKey(b)]);
		return Response.redirect(`${origin}/${env.TOKEN}`, 303);
	}
	if (a === "read" && b) return serveRead(env, origin, b);
	// Test clips from debug jobs, so they can be heard on a phone.
	if (a === "debug" && b && /^[\w-]+\.mp3$/.test(b)) {
		const obj = await env.AUDIO.get(`debug/${b}`);
		return obj ? new Response(obj.body, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(obj.size) } }) : new Response("Not found", { status: 404 });
	}
	if (a === "add") {
		const add = await readAddRequest(req, url);
		// The status page form posts here from a browser. Shortcuts and scripts get a short text reply.
		if (!wantsHtml(req)) return queueReply(req, env, add);
		const bad = addProblem(add);
		if (bad) return new Response(bad, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
		const { same } = await addItem(env, add);
		return html(statusPage(env, origin, await withProgress(env, await listItems(env)), same ? `${same} ${add.target}` : `OM NOM NOM! In my 🫦 MOUTH: ${add.content ? (add.title ?? "a big pile of text") : add.target} 😋 🦷 CHEWING soon.`));
	}
	if (a === "retry" && b) {
		const item = await loadItem(env, b);
		if (!item) return new Response("Not found", { status: 404 });
		await rechomp(env, item);
		if (wantsHtml(req)) return Response.redirect(`${origin}/${env.TOKEN}`, 303);
		return Response.json({ ok: true });
	}
	return new Response("Not found", { status: 404 });
}

const wantsHtml = (req: Request) => (req.headers.get("accept") ?? "").includes("text/html");

/** Reply as JSON if the client asks for JSON, else as plain text (the iOS Shortcut shows it as a notification). */
function reply(req: Request, status: number, message: string, extra: Record<string, unknown> = {}): Response {
	if ((req.headers.get("accept") ?? "").includes("application/json")) return Response.json({ ok: status < 400, message, ...extra }, { status });
	return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function addProblem(add: AddRequest): string | undefined {
	if (add.content && add.content.length > MAX_TEXT) return `TOO MUCH. ${add.content.length.toLocaleString("en-GB")} characters?! Even I have limits. Max ${MAX_TEXT.toLocaleString("en-GB")}. 🤢`;
	if (!add.content && !add.target) return "BLEH. NO LINK. NO TEXT. You fed me an EMPTY SPOON. Send a link or some content, then try AGAIN. I am STARVING. 😤";
}

async function queueReply(req: Request, env: Env, add: AddRequest): Promise<Response> {
	const bad = addProblem(add);
	if (bad) return reply(req, 400, bad);
	const { item, same } = await addItem(env, add);
	if (same) return reply(req, 200, `${same} 😋`, { id: item.id });
	const what = add.content ? `${add.title ?? "a big pile of text"} (${add.content.length.toLocaleString("en-GB")} characters)` : add.target;
	return reply(req, 200, `OM NOM NOM! SWALLOWED: ${what} 😋🦷 Burping it into your feed soon.`, { id: item.id });
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

// ---------- Queue consumer ----------

// Edge TTS can be slow or down for a while. Retry gaps: 2, 4, 8, 16 min (see retryDelay).
// Keep in step with max_retries in wrangler.jsonc (MAX_ATTEMPTS - 1).
const MAX_ATTEMPTS = 5;
const retryDelay = (attempt: number) => Math.min(120 * 2 ** (attempt - 1), 1800);

/** Debug job: speak one sentence with one engine and save the result under debug/. */
async function debugJob(env: Env, job: Job): Promise<void> {
	const engine = job.debug as "edge" | "workers-ai";
	const name = /^[\w-]{1,40}$/.test(job.id) ? job.id : engine;
	const start = Date.now();
	const report: Record<string, unknown> = { engine, voice: job.voice, rate: job.rate, pitch: job.pitch, format: job.format, pause: job.pause, at: new Date().toISOString() };
	try {
		const tts = { ...env, TTS_ENGINE: engine === "edge" ? "edge-only" : "workers-ai" };
		if (job.format) tts.EDGE_FORMAT = job.format;
		if (job.pause !== undefined) tts.EDGE_PAUSE_MS = String(job.pause);
		if (job.voice && /^[\w-]+$/.test(job.voice)) tts.VOICE = job.voice;
		// Prosody values, such as "-5%" or "-2Hz".
		if (job.rate && /^[+-]\d{1,2}%$/.test(job.rate)) tts.RATE = job.rate;
		if (job.pitch && /^[+-]\d{1,2}(%|Hz)$/.test(job.pitch)) tts.PITCH = job.pitch;
		const { mp3, engine: used } = await speak(tts, job.text || "Hello. This is a test of Podchast, running on Cloudflare.");
		await env.AUDIO.put(`debug/${name}.mp3`, mp3, { httpMetadata: { contentType: "audio/mpeg" } });
		// The first MP3 frame header: bytes 1 and 2 hold the bitrate and sample rate.
		const at = mp3.findIndex((b, i) => b === 0xff && (mp3[i + 1] & 0xe0) === 0xe0);
		Object.assign(report, { ok: true, used, bytes: mp3.length, duration: mp3Duration(mp3), frame: at >= 0 ? [...mp3.subarray(at, at + 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ") : undefined });
	} catch (e) {
		Object.assign(report, { ok: false, error: String((e as Error)?.stack ?? e) });
	}
	report.ms = Date.now() - start;
	await env.AUDIO.put(`debug/${name}.json`, JSON.stringify(report, null, 1));
}

/** Debug job: extract one URL (or the first item of an RSS feed) and save the text under debug/. */
async function debugExtract(env: Env, id: string, url: string): Promise<void> {
	const report: Record<string, unknown> = { url };
	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		const body = await resp.text();
		if (/<rss|<feed/i.test(body.slice(0, 500))) {
			const m = /<item>[\s\S]*?<link>([^<]+)<\/link>/i.exec(body) ?? /<entry>[\s\S]*?<link[^>]*href="([^"]+)"/i.exec(body);
			if (m) url = report.url = m[1].trim();
		}
		const art = await fetchArticle(url);
		Object.assign(report, { ok: true, ...art, chars: art.text.length });
	} catch (e) {
		Object.assign(report, { ok: false, error: String((e as Error)?.message ?? e) });
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } });
			const html = await r.text();
			// The whole page, so the extractor can be tested on it locally.
			await env.AUDIO.put(`debug/extract-${id}.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
			const at = html.search(/<p[ >]/i);
			Object.assign(report, { status: r.status, type: r.headers.get("content-type"), length: html.length, pCount: (html.match(/<p[ >]/gi) ?? []).length, firstP: at >= 0 ? html.slice(Math.max(0, at - 300), at + 500) : html.slice(0, 800) });
		} catch {}
	}
	await env.AUDIO.put(`debug/extract-${id}.json`, JSON.stringify(report, null, 1));
}

async function processJob(env: Env, job: Job, attempt: number): Promise<void> {
	if (job.debug === "extract") return debugExtract(env, job.id, job.url ?? "");
	if (job.debug) return debugJob(env, job);
	if (job.chunk !== undefined) return chunkJob(env, job, attempt);
	if (job.join) return joinJob(env, job, attempt);
	return prepareJob(env, job, attempt);
}

/** Save a failed attempt on the item. On the last attempt the item fails. Returns true if the queue should try again. */
async function attemptFailed(env: Env, item: Item, e: unknown, attempt: number, where = ""): Promise<boolean> {
	const msg = String((e as Error)?.message ?? e);
	console.error(`Job ${item.id}${where} attempt ${attempt} failed:`, msg);
	item.error = where ? `${msg} (${where.trim()}, attempt ${attempt}/${MAX_ATTEMPTS})` : msg;
	// Do not retry an error that a retry cannot fix.
	const last = attempt >= MAX_ATTEMPTS || isPermanent(e);
	if (last) {
		item.status = "failed";
		item.attempt = attempt;
		item.retryAt = undefined;
		await addFailureClip(env, item);
	} else if (!where) {
		item.status = "queued";
		item.retryAt = new Date(Date.now() + retryDelay(attempt) * 1000).toISOString();
	}
	await saveItem(env, item);
	return !last;
}

/** Step 1: read the article, plan the chunks, and queue one job for each chunk. */
async function prepareJob(env: Env, job: Job, attempt: number): Promise<void> {
	const item = await loadItem(env, job.id);
	if (!item || (item.status === "done" && !job.force)) return;
	// A run that Cloudflare stops (too much CPU) cannot save an error. The next attempt finds it still "processing".
	const stopped = item.status === "processing" && item.attempt !== undefined && item.attempt < attempt;
	item.error = stopped ? `Cloudflare: exceededCpu (attempt ${item.attempt}/${MAX_ATTEMPTS})` : undefined;
	item.status = "processing";
	item.attempt = attempt;
	item.retryAt = undefined;
	item.run = undefined;
	item.chunks = undefined;
	// Part 1 of an article that older code split into parts is now made as one whole episode.
	if (item.part === 1) {
		item.part = undefined;
		item.parts = undefined;
	}
	// Re-chomp of 🍖 MEAT or of a done episode: read the kept text again. It gets a new date.
	const again = !!(item.gone || job.force);
	await saveItem(env, item);
	try {
		// Older items: a part 2 or later keeps its own text in parts/.
		const { text, headings } = item.part ? await partText(env, item) : await loadArticle(env, item);
		const partNote = item.parts ? ` Part ${item.part} of ${item.parts}.` : "";
		const intro = [item.title?.replace(/[.!?]?$/, "."), item.byline && `By ${item.byline}.`, item.site && `From ${item.site}.`].filter(Boolean).join(" ") + partNote;
		const outro = item.parts && item.part !== item.parts ? `End of part ${item.part}. Part ${(item.part ?? 1) + 1} follows.` : "End of article.";
		const script = `${intro}\n\n${text}\n\n${outro}`;
		item.chars = script.length;
		item.words = text.split(/\s+/).filter(Boolean).length;
		const chunks = chunkText(script, CHUNK_CHARS);
		const run = crypto.randomUUID().slice(0, 8);
		const plan: Plan = { chunks, headings, again };
		await env.AUDIO.put(`${chunkDir(item.id, run)}plan.json`, JSON.stringify(plan), { httpMetadata: { contentType: "application/json" } });
		item.run = run;
		item.chunks = chunks.length;
		item.attempt = undefined;
		await saveItem(env, item);
		// A queue batch takes at most 100 messages.
		for (let i = 0; i < chunks.length; i += 100) {
			await env.JOBS.sendBatch(chunks.slice(i, i + 100).map((_, k) => ({ body: { id: item.id, run, chunk: i + k } })));
		}
	} catch (e) {
		if (await attemptFailed(env, item, e, attempt)) throw e;
	}
}

/** Step 2: speak one chunk. The last chunk to finish queues the join. */
async function chunkJob(env: Env, job: Job, attempt: number): Promise<void> {
	const n = job.chunk!;
	const item = await loadItem(env, job.id);
	// An older try, a failed item or a deleted item: nothing to do.
	if (!item || item.status !== "processing" || item.run !== job.run || !job.run) return;
	const dir = chunkDir(item.id, job.run);
	const plan = await getJson<Plan>(env, `${dir}plan.json`);
	if (!plan) return;
	try {
		const r = await speakChunk(env, plan.chunks[n]);
		await env.AUDIO.put(`${dir}${n}.mp3`, r.mp3, { httpMetadata: { contentType: "audio/mpeg" } });
		const meta: ChunkMeta = { seconds: r.seconds, bytes: r.mp3.length, cues: r.cues, engine: r.engine, edgeError: r.edgeError };
		await env.AUDIO.put(`${dir}${n}.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
		console.log(`Chunk ${n + 1}/${plan.chunks.length} of ${item.id}: ${r.mp3.length} bytes, ${Math.round(r.seconds)} s`);
	} catch (e) {
		// Load the item again: other chunks may have changed it.
		const fresh = await loadItem(env, job.id);
		if (!fresh || fresh.run !== job.run || fresh.status !== "processing") return;
		if (await attemptFailed(env, fresh, e, attempt, ` chunk ${n + 1}/${plan.chunks.length}`)) throw e;
		return;
	}
	if ((await countChunks(env, dir)) >= plan.chunks.length) await env.JOBS.send({ id: item.id, run: job.run, join: true });
}

/** How many chunks in a try are done. */
async function countChunks(env: Env, dir: string): Promise<number> {
	let done = 0;
	let cursor: string | undefined;
	do {
		const page = await env.AUDIO.list({ prefix: dir, cursor, limit: 1000 });
		done += page.objects.filter((o) => /\/\d+\.json$/.test(o.key)).length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return done;
}

/** Step 3: put the chunks together into one MP3 with chapters and a transcript. The audio is streamed from R2 to R2, so it uses little CPU. */
async function joinJob(env: Env, job: Job, attempt: number): Promise<void> {
	const item = await loadItem(env, job.id);
	if (!item || item.status !== "processing" || item.run !== job.run || !job.run) return;
	const dir = chunkDir(item.id, job.run);
	try {
		const plan = await getJson<Plan>(env, `${dir}plan.json`);
		if (!plan) throw new Error("Podchast: the chunk plan is missing");
		const metas = await Promise.all(plan.chunks.map((_, i) => getJson<ChunkMeta>(env, `${dir}${i}.json`)));
		const missing = metas.findIndex((m) => !m);
		if (missing >= 0) throw new Error(`Podchast: chunk ${missing + 1}/${plan.chunks.length} is missing`);
		const ms = metas as ChunkMeta[];
		const lens = ms.map((m) => m.seconds);
		const seconds = Math.round(lens.reduce((a, b) => a + b, 0));
		// Chapters: the article start, then one for each heading.
		const marks = chunkTimes(plan.chunks, lens);
		const chapters: Chapter[] = [{ title: item.title ?? "Start", start: 0 }];
		for (const h of plan.headings) {
			const start = marks(h);
			if (start !== undefined && start > chapters[chapters.length - 1].start + 1) chapters.push({ title: h.replace(/\.$/, ""), start });
		}
		const tag = id3Tag(item.title ?? "Podchast", chapters, seconds);
		const bytes = tag.length + ms.reduce((n, m) => n + m.bytes, 0);
		// One stream: the tag, then each chunk in order. R2 needs the length first.
		const { readable, writable } = new FixedLengthStream(bytes);
		const pump = (async () => {
			const w = writable.getWriter();
			await w.write(tag);
			w.releaseLock();
			for (let i = 0; i < ms.length; i++) {
				const obj = await env.AUDIO.get(`${dir}${i}.mp3`);
				if (!obj) throw new Error(`Podchast: audio for chunk ${i + 1}/${ms.length} is missing`);
				await obj.body.pipeTo(writable, { preventClose: true });
			}
			await writable.close();
		})();
		await Promise.all([env.AUDIO.put(audioKey(item.id), readable, { httpMetadata: { contentType: "audio/mpeg" } }), pump]);
		await env.AUDIO.put(transcriptKey(item.id), chunkVtt(plan.chunks, lens, ms.map((m) => m.cues)), { httpMetadata: { contentType: "text/vtt; charset=utf-8" } });
		const engines = new Set(ms.map((m) => m.engine));
		const edgeError = ms.find((m) => m.edgeError)?.edgeError;
		item.transcript = true;
		item.bytes = bytes;
		item.duration = seconds;
		item.chapters = chapters.length >= 2 ? chapters.length : undefined;
		item.engine = [...engines].join("+");
		item.error = edgeError ? `Edge TTS failed, used Workers AI: ${edgeError}` : undefined;
		item.status = "done";
		item.attempt = undefined;
		item.retryAt = undefined;
		item.chunks = undefined;
		if (item.gone || plan.again) {
			item.gone = undefined;
			item.aired = new Date().toISOString();
		}
		await saveItem(env, item);
		if (item.parts || item.text) await env.AUDIO.delete(partKey(item.id));
		await deletePrefix(env, `chunks/${item.id}/`);
	} catch (e) {
		if (await attemptFailed(env, item, e, attempt, " join")) throw e;
	}
}

async function deletePrefix(env: Env, prefix: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await env.AUDIO.list({ prefix, cursor, limit: 1000 });
		if (page.objects.length) await env.AUDIO.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/** Chunks done for each item that is being spoken, for the status page. */
async function withProgress(env: Env, items: Item[]): Promise<Item[]> {
	await Promise.all(
		items
			.filter((i) => i.status === "processing" && i.run)
			.map(async (i) => {
				const page = await env.AUDIO.list({ prefix: chunkDir(i.id, i.run!), limit: 1000 });
				const done = page.objects.filter((o) => /\/\d+\.json$/.test(o.key)).length;
				const last = Math.max(Date.parse(i.updated ?? i.created), ...page.objects.map((o) => o.uploaded.getTime()));
				i.progress = { done, last };
			}),
	);
	return items;
}

/** Fetch the article (or read the kept text) and fill in the item's details. The whole article becomes one episode. */
async function loadArticle(env: Env, item: Item): Promise<PartText> {
	// Text we already keep is read from R2. A web page is only fetched the first time, so a re-chomp reads the copy we saved.
	let pdf: ArrayBuffer | undefined;
	const kept = item.text || item.saved;
	const art = kept
		? await textArticle(env, item)
		: await fetchArticle(item.url, (bytes, url) => {
				pdf = bytes;
				return pdfArticle(env, bytes, url);
			});
	if (!kept) {
		await env.AUDIO.put(readKey(item.id), articleMarkdown(art), { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
		item.saved = true;
	}
	if (pdf) {
		await env.AUDIO.put(pdfKey(item.id), pdf, { httpMetadata: { contentType: "application/pdf" } });
		item.pdf = true;
	}
	item.title = art.title;
	item.byline = art.byline ?? item.byline;
	item.site = art.site ?? item.site;
	item.excerpt = art.excerpt ?? item.excerpt ?? art.text.slice(0, 300);
	const image = art.image ?? item.image;
	item.image = image && image.length <= 400 ? image : undefined;
	return { text: art.text, headings: art.headings ?? [] };
}

/** Turn a PDF into markdown with Workers AI (free for PDFs). Page headings are dropped, so they do not become chapters. */
async function pdfMarkdown(env: Env, name: string, bytes: ArrayBuffer | Uint8Array): Promise<string> {
	const res = await env.AI.toMarkdown({ name, blob: new Blob([bytes], { type: "application/pdf" }) }, { conversionOptions: { pdf: { metadata: false } } } as any);
	if (res.format === "error") throw new Error(`Workers AI toMarkdown: ${(res as any).error ?? "format error"}`);
	return res.data
		.split("\n")
		.filter((l) => !/^#{1,6}\s*(Page \d+|Contents|Metadata)\s*$/i.test(l.trim()))
		.join("\n");
}

async function pdfArticle(env: Env, bytes: ArrayBuffer, url: string): Promise<Article> {
	const file = decodeURIComponent(new URL(url).pathname.split("/").pop() || "document.pdf");
	const { text, headings, h1 } = markdownToSpeech(await pdfMarkdown(env, file, bytes));
	if (!text) throw new Error("Podchast: PDF has no text (it may be scanned images)");
	return { title: h1 || file.replace(/\.pdf$/i, ""), text, headings, site: new URL(url).hostname.replace(/^www\./, "") };
}

/** Read text that was sent to /add. Markdown is made plain, and its headings become chapters. */
async function textArticle(env: Env, item: Item): Promise<Article> {
	// Older items kept their text in parts/ until the job read it.
	const obj = (await env.AUDIO.get(readKey(item.id))) ?? (await env.AUDIO.get(partKey(item.id)));
	if (!obj) throw new Error("Podchast: the saved text is missing");
	const { text, headings, h1 } = markdownToSpeech(await obj.text());
	if (!text) throw new Error("Podchast: the text was empty after I took out the markdown");
	const title = item.title?.replace(/ \(Part \d+ of \d+\)$/, "") || h1 || text.split("\n")[0].slice(0, 80).replace(/\s+\S*$/, "") + (text.length > 80 ? "…" : "");
	return { title, text, headings, site: item.url ? new URL(item.url).hostname.replace(/^www\./, "") : undefined };
}

/** The article as markdown, to keep in read/<id>.md. Re-chomp reads it back with markdownToSpeech. */
function articleMarkdown(art: Article): string {
	const headings = new Set(art.headings ?? []);
	const body = art.text
		.split(/\n{2,}/)
		.map((p) => (headings.has(p) ? `## ${p.replace(/\.$/, "")}` : p.replace(/^(#|[-*+] |\d+[.)] |>)/, "\\$1")))
		.join("\n\n");
	return `# ${art.title}\n\n${body}\n`;
}

/** Turn markdown (or plain text) into paragraphs to read aloud. */
function markdownToSpeech(md: string): { text: string; headings: string[]; h1?: string } {
	const paras: string[] = [];
	const headings: string[] = [];
	let h1: string | undefined;
	let buf: string[] = [];
	let fence = false;
	const flush = () => {
		if (buf.length) paras.push(buf.join(" "));
		buf = [];
	};
	const inline = (s: string) =>
		s
			.replace(/<[^>]+>/g, "")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/(\*\*|__)(.+?)\1/g, "$2")
			.replace(/(^|\W)[*_]([^*_\s][^*_]*?)[*_](?=\W|$)/g, "$1$2")
			.replace(/~~(.+?)~~/g, "$1")
			.replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, "$1") // Markdown escapes.
			.replace(/\s+/g, " ")
			.trim();
	for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fence = !fence;
			flush();
			continue;
		}
		if (fence) continue; // Code is not read aloud.
		if (/^\s*$/.test(line) || /^\s*([-*_]\s*){3,}$/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line)) {
			flush();
			continue;
		}
		const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (h) {
			flush();
			const t = inline(h[2]);
			if (!t) continue;
			if (h[1].length === 1 && !h1 && !paras.length) {
				h1 = t; // The title is read in the intro, so it is not read twice.
				continue;
			}
			const p = /[.!?:]$/.test(t) ? t : `${t}.`;
			paras.push(p);
			if (p.length <= 200) headings.push(p);
			continue;
		}
		// List items and quotes become their own sentences.
		const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
		if (item) {
			flush();
			const t = inline(item[1]);
			if (t) paras.push(/[.!?:;]$/.test(t) ? t : `${t}.`);
			continue;
		}
		const t = inline(line.replace(/^\s*>+\s?/, "").replace(/\|/g, " "));
		if (t) buf.push(t);
	}
	flush();
	return { text: paras.join("\n\n"), headings, h1 };
}

async function partText(env: Env, item: Item): Promise<PartText> {
	const obj = await env.AUDIO.get(partKey(item.id));
	if (!obj) throw new Error(`Podchast: the text for part ${item.part} is missing`);
	const raw = await obj.text();
	try {
		return JSON.parse(raw) as PartText;
	} catch {
		return { text: raw, headings: [] }; // Older plain-text parts.
	}
}

// ---------- Failure alerts ----------
// A failed item shows in the feed as a short episode. All failed items share one
// spoken clip; the reason is in the show notes, not in the audio.

const FAILED_ID = "failed-v3";

/** Make the shared "could not read this article" clip if it does not exist yet. */
async function failureClip(env: Env): Promise<R2Object | null> {
	const head = await env.AUDIO.head(audioKey(FAILED_ID));
	if (head) return head;
	const { mp3 } = await speak(env, "Bleurgh! Blech! Ptoo! I am the Mimic, and this article tasted like rusty nails and wet socks. I spat it out. I could not chew it into noises. The notes say what got stuck in my teeth. Share the link again and I will try another bite. Om nom. Om nom nom.");
	return env.AUDIO.put(audioKey(FAILED_ID), mp3, { httpMetadata: { contentType: "audio/mpeg" } });
}

async function addFailureClip(env: Env, item: Item): Promise<void> {
	try {
		const head = await failureClip(env);
		item.bytes = head?.size;
		item.duration = head ? Math.round((head.size * 8) / (Number(/(\d+)kbitrate/.exec(env.EDGE_FORMAT ?? "")?.[1] ?? 48) * 1000)) : undefined;
	} catch (e) {
		console.error("Could not make the failure clip:", e);
	}
}

export default {
	fetch: async (req, env) => {
		const resp = await handleFetch(req, env).catch((e) => {
			console.error(e);
			return new Response("Server error", { status: 500 });
		});
		// Web-based podcast players (Pocket Casts on desktop and web) load artwork and audio with fetch(), which needs CORS.
		const headers = new Headers(resp.headers);
		headers.set("Access-Control-Allow-Origin", "*");
		headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
		return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
	},

	async queue(batch, env) {
		for (const msg of batch.messages) {
			try {
				await processJob(env, msg.body, msg.attempts);
				msg.ack();
			} catch {
				msg.retry({ delaySeconds: retryDelay(msg.attempts) });
			}
		}
	},

	// Daily clean-up. Old audio is deleted, and its item becomes 🍖 MEAT. Items and read/ copies stay forever.
	// The R2 lifecycle rules also delete old audio/ and parts/ objects; this is a backup, and it marks the items.
	async scheduled(_ctl, env) {
		const cutoff = Date.now() - retentionMs(env);
		for (const prefix of ["audio/", "parts/"]) {
			let cursor: string | undefined;
			do {
				const page = await env.AUDIO.list({ prefix, cursor, limit: 1000 });
				const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
				if (old.length) await env.AUDIO.delete(old);
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
		}
		// Mark done items whose audio is old (or already deleted by the lifecycle rule).
		for (const item of await listItems(env)) {
			if (item.status !== "done" || item.gone || Date.parse(item.aired ?? item.created) > cutoff) continue;
			if (await env.AUDIO.head(audioKey(item.id))) continue;
			const full = await loadItem(env, item.id);
			if (!full) continue;
			full.gone = true;
			full.transcript = undefined;
			await saveItem(env, full);
		}
	},

	// Email to Podchast (Email Routing sends devour@ mail here). Allowed senders only.
	async email(message, env) {
		const from = message.from.toLowerCase();
		const allowed = (env.EMAIL_FROM ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
		if (!allowed.some((a) => (a.startsWith("@") ? from.endsWith(a) : from === a))) return message.setReject("I only eat mail from my keeper. 🦷");
		if (/dmarc=fail/i.test(message.headers.get("authentication-results") ?? "")) return message.setReject("Your mail smells forged. 🤮");
		const raw = new TextDecoder().decode(await new Response(message.raw).arrayBuffer());
		const mail = readMail(raw);
		const subject = mail.subject.replace(/^((re|fwd?|fw)\s*:\s*)+/i, "").trim();
		const added: string[] = [];
		// Each PDF becomes an episode. Its title is the subject (one PDF) or the file name.
		for (const pdf of mail.pdfs) {
			const markdown = await pdfMarkdown(env, pdf.name, pdf.bytes);
			const title = (mail.pdfs.length === 1 && subject) || pdf.name.replace(/\.pdf$/i, "");
			const add: AddRequest = { token: "", target: null, content: markdown.trim(), title, pdf: pdf.bytes };
			if (!addProblem(add)) added.push((await addItem(env, add)).item.id);
		}
		if (!mail.pdfs.length) {
			// A short body with a link means "eat this link". Anything longer is the text itself.
			const target = findUrl(mail.text);
			const rest = mail.text.replace(/https?:\/\/\S+/g, "").trim();
			const add: AddRequest =
				target && rest.length < 300 ? { token: "", target, title: undefined } : { token: "", target: null, content: mail.text, title: subject || undefined };
			if (!addProblem(add)) added.push((await addItem(env, add)).item.id);
		}
		console.log(`Email: added ${added.length} item(s) ${added.join(", ")}`);
		if (!added.length) message.setReject("BLEH. That email had nothing I could eat. 😤");
	},
} satisfies ExportedHandler<Env, Job>;
