import cover from "../assets/cover.jpg";
import hero from "../assets/hero.jpg";
import icon180 from "../assets/icon-180.png";
import icon192 from "../assets/icon-192.png";
import icon512 from "../assets/icon-512.png";
import { type Article, chunkText, fetchArticle } from "./extract";
import { readMail } from "./mail";
import { concat } from "./edge-tts";
import { type Chapter, id3Tag } from "./id3";
import { mp3Duration, speak, type TtsEnv } from "./tts";

export interface Env extends TtsEnv {
	AUDIO: R2Bucket;
	JOBS: Queue<Job>;
	TOKEN: string; // Secret. Guards /add and is part of the feed URL.
	FEED_TITLE: string;
	RETENTION_DAYS: string;
	SHORTCUT_URL?: string; // iCloud link to the iOS Shortcut, shown on the status page.
	EMAIL_TO?: string; // Address that Email Routing sends to this Worker, shown on the status page.
	EMAIL_FROM?: string; // Secret. Sender addresses (or @domains) allowed to email Podchast, comma separated.
}

// Debug jobs: "edge" and "workers-ai" speak `text` (or a test sentence) into debug/<id>.mp3. EDGE_FORMAT and EDGE_PAUSE_MS can be set for one job.
type Job = { id: string; debug?: "edge" | "workers-ai" | "extract"; url?: string; force?: boolean; text?: string; format?: string; pause?: number };

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
};

// Text for one episode, with the headings that become chapters.
type PartText = { text: string; headings: string[] };

// ---------- Storage (R2 only) ----------
// items/<id>  JSON item, also copied into customMetadata so one list() call builds the feed.
// audio/<id>.mp3  Deleted after RETENTION_DAYS. The item stays.
// parts/<id>.txt  Text for one part of a long article, deleted when that part is done.
// read/<id>.md    The article text, kept forever. read/<id>.pdf is the original PDF, if there was one.

const itemKey = (id: string) => `items/${id}`;
const partKey = (id: string) => `parts/${id}.txt`;
const readKey = (id: string) => `read/${id}.md`;
const pdfKey = (id: string) => `read/${id}.pdf`;
// Part 2 of an article shares the text of part 1.
const rootId = (id: string) => id.replace(/-p\d+$/, "");

// Articles longer than this are split into several episodes (about 40 minutes each).
// Each part is its own queue job, so each part gets its own subrequest and time limits.
const PART_CHARS = 40_000;
// Biggest text /add takes (about 7 hours of audio).
const MAX_TEXT = 400_000;
const audioKey = (id: string) => `audio/${id}.mp3`;

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

async function addItem(env: Env, add: AddRequest): Promise<Item> {
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
	return item;
}

async function serveAudio(env: Env, req: Request, id: string): Promise<Response> {
	const obj = await env.AUDIO.get(audioKey(id), { range: req.headers, onlyIf: req.headers });
	if (!obj) return new Response("Not found", { status: 404 });
	const headers = new Headers({
		"Content-Type": "audio/mpeg",
		"Accept-Ranges": "bytes",
		ETag: obj.httpEtag,
		"Cache-Control": "private, max-age=86400",
	});
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
						i.url && `<p><a href="${esc(i.url)}">Read the article</a>${i.site ? ` on ${esc(i.site)}` : ""}</p>`,
						facts.length && `<p>${esc(facts.join(" · "))}</p>`,
					].filter(Boolean);
			const plain = failed ? `BLEURGH! I could not eat this article. Stuck in my teeth: ${i.error ?? "a mystery bone"}. ${i.url}`.trim() : [i.excerpt, i.byline && `By ${i.byline}.`, i.url && `Source: ${i.url}`, facts.join(" · ")].filter(Boolean).join("\n\n");
			const audio = failed ? `${base}/audio/${FAILED_ID}.mp3?for=${i.id}` : `${base}/audio/${i.id}.mp3`;
			return `<item>
<title>${esc(name)}</title>
<link>${esc(i.url || base)}</link>
<guid isPermaLink="false">${esc(i.id)}</guid>
<pubDate>${new Date(i.aired ?? i.created).toUTCString()}</pubDate>
<description>${esc(plain)}</description>
<content:encoded><![CDATA[${notes.join("\n").replaceAll("]]>", "]]&gt;")}]]></content:encoded>
<enclosure url="${esc(audio)}" length="${i.bytes ?? 0}" type="audio/mpeg"/>
<itunes:duration>${hms(i.duration)}</itunes:duration>
${i.image && !failed ? `<itunes:image href="${esc(i.image)}"/>` : ""}
${i.byline ? `<itunes:author>${esc(i.byline)}</itunes:author>` : ""}
<itunes:explicit>false</itunes:explicit>
</item>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
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
	"Every episode is fresh from my 🕳️ ABYSS. Warm. Slightly damp. Narrated by a polite New Zealander I keep in a JAR.",
	"Do not put your hand in me. Put a LINK in me. Hands are crunchy and links are crunchier.",
];
function growl(days: number): string {
	const line = GROWLS[Math.floor(Math.random() * GROWLS.length)];
	return `${line} NOISES fade after ${days} days. The words stay in my 🕳️ ABYSS FOREVER. 🦷📜💥`;
}

const STATUS_LABEL: Record<Status, string> = { queued: "🫦 MOUTH", processing: "🦷 CHEWING", done: "💥 NOISE", failed: "🤮 YUCK" };
// Done, but the audio is gone. Only the text is left.
const MEAT = "🍖 MEAT";

function statusPage(env: Env, origin: string, items: Item[], note = ""): string {
	const base = `${origin}/${env.TOKEN}`;
	// A bookmark that sends the current page to /add, then shows this page.
	const bookmarklet = `javascript:location.href=${JSON.stringify(`${base}/add?url=`)}+encodeURIComponent(location.href)`;
	const title = "🍖 PODCHAST";
	const rows = items
		.map((i) => {
			const meta = [i.duration && hms(i.duration), i.words && `${i.words.toLocaleString("en-GB")} words`, i.chapters && `${i.chapters} chapters`, i.site, new Date(i.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })].filter(Boolean);
			return `<li class="card">
<div class="row">${i.gone && i.status === "done" ? `<span class="pill meat">${MEAT}</span>` : `<span class="pill ${i.status}">${STATUS_LABEL[i.status]}</span>`}<span class="meta">${esc(meta.join(" · "))}</span></div>
<h3>${esc(i.title ?? (i.url || "Some text"))}</h3>
${i.error ? `<p class="err">${esc(i.error)}</p>` : ""}
<div class="row actions">${i.saved ? `<a href="${esc(`${base}/read/${rootId(i.id)}`)}">Read</a>` : ""}${i.status === "done" && !i.gone ? `<a href="${esc(`${base}/audio/${i.id}.mp3`)}">Play</a>` : ""}${i.url ? `<a href="${esc(i.url)}">Source</a>` : ""}${i.pdf ? `<a href="${esc(`${base}/read/${rootId(i.id)}.pdf`)}">PDF</a>` : ""}${i.status === "failed" || (i.gone && i.status === "done" && (i.part ?? 1) === 1) ? `<form method="post" action="${esc(`${base}/retry/${i.id}`)}"><button class="link">Re-chomp</button></form>` : ""}
<form method="post" action="${esc(`${base}/delete/${i.id}`)}" onsubmit="return confirm('DELETE this one? Forever? No take-backs??')"><button class="link danger">Delete</button></form></div>
</li>`;
		})
		.join("");
	const copy = (label: string, value: string, cls = "btn") =>
		`<button type="button" class="${cls}" onclick="navigator.clipboard.writeText('${esc(value)}').then(()=>this.textContent=NOMS[Math.floor(Math.random()*NOMS.length)])">${label}</button>`;
	const shortcut = env.SHORTCUT_URL
		? `<p>HELLO TINY GLASS RECTANGLE. Put me in your share sheet:</p><ol class="steps"><li>Tap <b>Copy MOUTH URL</b>.</li><li>Tap <b>Add 🍖 DEVOUR shortcut</b>. When Shortcuts asks, paste the URL.</li><li>In Safari or any app, tap <b>Share → 🍖 DEVOUR</b>. I EAT IT. OM.</li></ol>
<div class="row">${copy("Copy MOUTH URL 🫦", `${base}/add`)}<a class="btn gold" href="${esc(env.SHORTCUT_URL)}">Add 🍖 DEVOUR shortcut</a></div>`
		: `<p>NO SHORTCUT LINK?! RUDE. Fine. Build a Shortcut that sends a POST with JSON <code class="inline">{"url": "…"}</code> to my 🫦 MOUTH URL. The README has the steps. (I do not read READMEs. I EAT them.)</p><div class="row">${copy("Copy MOUTH URL 🫦", `${base}/add`)}</div>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<link rel="manifest" href="${esc(base)}/manifest.webmanifest"><link rel="apple-touch-icon" href="${esc(base)}/icon-180.png"><link rel="icon" href="${esc(base)}/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="${esc(title)}"><meta name="theme-color" content="#0392b4"><script>document.documentElement.classList.add("js")</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;700&display=swap" rel="stylesheet">
<style>
:root{--teal:#05aabe;--teal-d:#0392b4;--teal-dd:#0b5f78;--ink:#20293c;--parch:#f7e6c4;--parch-d:#e8cf9f;--wood:#6b4226;--iron:#3d4450;--gold:#f2b632;--ember:#ff7a1a;--red:#c8323c;--green:#2f9e5b}
*{box-sizing:border-box}
html{background:var(--teal-d)}
body{margin:0;min-height:100vh;font:16px/1.5 system-ui,-apple-system,sans-serif;color:var(--ink);background:radial-gradient(circle at 50% 0,#22c3d4 0,var(--teal) 35%,var(--teal-d) 100%) fixed;padding:env(safe-area-inset-top) 16px 48px}
main{max-width:720px;margin:0 auto}
header.hero{position:relative;margin:16px 0;border:4px solid var(--iron);border-radius:22px;overflow:hidden;box-shadow:0 6px 0 rgba(0,0,0,.25);background:#2a1a10}
header.hero img{display:block;width:100%;aspect-ratio:1400/764;object-fit:cover}
header.hero>div{position:absolute;left:0;right:0;bottom:0;padding:48px 16px 14px;background:linear-gradient(transparent,rgba(20,10,4,.9))}
h1,h2,h3,.btn,.pill{font-family:Fredoka,system-ui,sans-serif}
h1{margin:0;font-size:44px;line-height:1;color:#fff;letter-spacing:1px;-webkit-text-stroke:2px var(--ink);paint-order:stroke fill;text-shadow:0 4px 0 var(--ink)}
header p{margin:6px 0 0;color:#e9fbff;font-weight:600}
.panel,.card{background:var(--parch);border:3px solid var(--iron);border-radius:16px;box-shadow:0 5px 0 rgba(0,0,0,.25)}
.panel{padding:16px;margin:16px 0}
.panel h2{margin:0 0 8px;font-size:20px;color:var(--wood)}
.panel p{margin:0 0 12px}
.note{background:var(--gold);border-color:var(--ink);font-weight:600}
input[type=url]{width:100%;padding:12px;font:inherit;border:3px solid var(--iron);border-radius:12px;background:#fffaf0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn,button.btn{display:inline-block;padding:10px 18px;font-size:17px;font-weight:700;color:#fff;background:var(--teal-d);border:3px solid var(--ink);border-radius:12px;box-shadow:0 4px 0 var(--ink);text-decoration:none;cursor:pointer}
.btn:active{transform:translateY(3px);box-shadow:0 1px 0 var(--ink)}
.btn.gold{background:var(--gold);color:var(--ink)}
form.add{display:flex;gap:8px;flex-wrap:wrap}form.add input{flex:1 1 260px}form.add details{flex:1 1 100%}form.add summary{cursor:pointer;font-weight:700;padding:4px 0}form.add details input,form.add textarea{display:block;width:100%;margin:8px 0;padding:12px;font:inherit;border:3px solid var(--iron);border-radius:12px;background:#fffaf0;color:inherit}
code{display:block;word-break:break-all;background:#fffaf0;border:2px dashed var(--parch-d);border-radius:8px;padding:8px;font-size:13px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}
.card{padding:12px 14px}
.card h3{margin:6px 0;font-size:19px;line-height:1.25;color:var(--ink)}
.meta{color:var(--wood);font-size:14px}
.pill{font-size:13px;font-weight:700;padding:2px 10px;border-radius:999px;border:2px solid var(--ink);background:#fff}
.pill.done{background:var(--green);color:#fff}.pill.processing{background:var(--ember);color:#fff}.pill.queued{background:var(--gold)}.pill.failed{background:var(--red);color:#fff}.pill.meat{background:#e07a5f;color:#fff}
.err{margin:4px 0;color:var(--red);font-size:14px}
.actions a,button.link{font:inherit;font-size:15px;font-weight:600;color:var(--teal-dd);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.actions{gap:14px;margin-top:4px}.actions form{display:inline}
button.danger{color:var(--red)}
.empty{text-align:center;color:var(--wood)}
.tabs{display:flex;gap:6px;margin:4px 0 12px;background:rgba(0,0,0,.18);padding:5px;border-radius:14px}
.tabs a{flex:1;text-align:center;padding:8px 6px;border-radius:10px;font:700 16px Fredoka,system-ui,sans-serif;color:#fff;text-decoration:none}
.tabs a[aria-selected=true]{background:var(--parch);color:var(--ink);box-shadow:0 3px 0 rgba(0,0,0,.25)}
.js .tab{display:none}.js .tab.on{display:block}
.tab .panel:first-child{margin-top:0}
.steps{display:block;padding-left:18px;list-style:disc}.steps li{margin:4px 0}ol.steps{list-style:decimal}.lead{color:#fff;font-weight:700;font-size:17px;margin:4px 4px 14px;text-shadow:0 2px 0 rgba(0,0,0,.25)}
code.inline{display:inline;padding:1px 4px;border-style:solid}
@media (prefers-color-scheme:dark){html{background:#04222c}:root{--parch:#2a2f3a;--parch-d:#444b59;--ink:#f3ead6;--wood:#e8cf9f;--teal-dd:#5fd8e6}body{background:radial-gradient(circle at 50% 0,#0b6f86 0,#06485a 45%,#04222c 100%) fixed}input[type=url],input[type=text],textarea,code{background:#1d222b !important;color:var(--ink)}.pill{color:#20293c}.pill.done,.pill.processing,.pill.failed,.pill.meat{color:#fff}.btn,button.btn{border-color:#20293c;box-shadow:0 4px 0 #000}.btn.gold{color:#20293c}h1{-webkit-text-stroke-color:#20293c;text-shadow:0 4px 0 #000}.note{color:#20293c}}
</style></head><body><main>
<header class="hero"><img src="/${HERO}" alt="The Mimic chest, eating a pile of articles"><div><h1>${esc(title)}</h1><p id="growl">ARTICLES IN. NOISES OUT. NOISES FADE IN ${retentionDays(env)} DAYS. WORDS STAY FOREVER. OM NOM.</p></div></header>
<nav class="tabs" role="tablist"><a href="#mouth" role="tab">🫦 MOUTH</a><a href="#abyss" role="tab">🕳️ ABYSS</a><a href="#noises" role="tab">💥 NOISES</a></nav>
<section id="mouth" class="tab">
<p class="lead">Feed things into my 🫦 MOUTH. I store them in my 🕳️ ABYSS. Then you hear the 💥 NOISES. OM NOM.</p>
<div class="panel"><h2>Add a URL or content</h2><form class="add" method="post" action="${esc(base)}/add"><input type="url" name="url" placeholder="https://… (PUT A LINK IN MY MOUTH)"><button class="btn gold">🍖 DEVOUR</button>
<details><summary>…or VOM A PILE OF TEXT AT ME 🤢</summary><input type="text" name="title" placeholder="Title (optional, I will guess)"><textarea name="content" rows="8" placeholder="Paste words. Markdown is fine. ## Headings become chapters. I EAT IT ALL."></textarea><button class="btn gold">🍖 DEVOUR</button></details></form></div>
<div class="panel"><h2>📱 iPhone and iPad</h2>${shortcut}</div>
<div class="panel"><h2>🔖 Any browser (Chrome too)</h2><ol class="steps"><li>Show your bookmarks bar. In Chrome, press <b>⌘⇧B</b>.</li><li>DRAG the button below onto the bar.</li><li>On any article, click the bookmark. The page goes in my 🫦 MOUTH.</li></ol><div class="row"><a class="btn gold" href="${esc(bookmarklet)}" onclick="event.preventDefault();this.textContent='DRAG ME. DO NOT POKE ME. 😤'">🍖 DEVOUR</a></div></div>
${env.EMAIL_TO ? `<div class="panel"><h2>📧 Email</h2><ol class="steps"><li>Send or forward anything to <b>${esc(env.EMAIL_TO)}</b>.</li><li>A link becomes its article. Longer text becomes an episode, and the subject is its title.</li><li>Attached PDFs become episodes too. I EAT PAPER.</li></ol><div class="row">${copy("Copy email address 📧", env.EMAIL_TO)}</div></div>` : ""}
<div class="panel"><h2>💻 Mac</h2><ol class="steps"><li>The iPhone Shortcut syncs through iCloud. In Safari, use <b>Share → 🍖 DEVOUR</b>.</li><li>Want me in your Dock? In Safari, choose <b>File → Add to Dock</b>. I will sit there. Watching. Hungry.</li></ol></div>
<div class="panel"><h2>🤖 Android</h2><ol class="steps"><li>Open this page in Chrome.</li><li>Tap <b>Add to Home screen</b>.</li><li>Share any link to <b>Podchast</b>. I pay no rent. I eat links. OM.</li></ol></div>
</section>
<section id="abyss" class="tab">
${note ? `<div class="panel note">${esc(note)}</div>` : ""}
<p class="lead">Everything in my 🕳️ ABYSS. Chewed things become 💥 NOISES. NOISES fade after ${retentionDays(env)} days, but I keep the ${MEAT} (the words) FOREVER. Re-chomp the ${MEAT} to hear it again.</p>
<ul>${rows || `<li class="card empty">My 🕳️ ABYSS is EMPTY. I AM SO HUNGRY. I could eat a WHOLE NEWSLETTER. Go to <a href="#mouth">🫦 MOUTH</a> and feed me before I eat the CSS. 🫥</li>`}</ul>
</section>
<section id="noises" class="tab">
<div class="panel"><h2>Listen to my 💥 NOISES in your podcast player</h2><p>Copy this URL. Add it to your podcast app. Keep it secret: anyone with the token in it can feed me. ANYONE.</p><code>${esc(base)}/${FEED}</code><div class="row" style="margin-top:10px">${copy("Copy NOISES URL 💥", `${base}/${FEED}`)}<a class="btn gold" href="${esc(base)}/${FEED}">Open raw XML 👀</a></div></div>
<div class="panel"><h2>Add it to your app</h2><ul class="steps"><li><b>Pocket Casts:</b> tap <b>Search</b>, then paste the URL.</li><li><b>Apple Podcasts:</b> tap <b>Library</b>, then <b>…</b>, then <b>Follow a Show by URL</b>, then paste. (Yes, it is hidden. Apple fears me.)</li><li><b>Overcast:</b> tap <b>+</b>, then <b>Add URL</b>, then paste.</li></ul></div>
</section>
</main>
<script>
function show(){var id=(location.hash||"#abyss").slice(1);id={articles:"abyss",guts:"abyss",feed:"noises",share:"mouth"}[id]||id;if(!document.getElementById(id))id="abyss";document.querySelectorAll(".tab").forEach(function(t){t.classList.toggle("on",t.id===id)});document.querySelectorAll(".tabs a").forEach(function(a){a.setAttribute("aria-selected",a.getAttribute("href")==="#"+id)})}
addEventListener("hashchange",show);show();
document.querySelectorAll(".tabs a").forEach(function(a){a.addEventListener("click",function(e){e.preventDefault();history.replaceState(null,"",a.getAttribute("href"));show()})});
var NOMS=["OM NOM! COPIED!","GULP! IN YOUR CLIPBOARD!","CHOMP. DONE. 🦷","*BURP* COPIED","YUM. CLIPBOARD FED."];
var GROWLS=["ARTICLES IN. NOISES OUT. OM NOM.","I AM A CHEST. I AM HUNGRY. THESE FACTS ARE RELATED.","FEED ME WORDS. I SPIT OUT PODCASTS. THIS IS SCIENCE.","I ATE A PAYWALL ONCE. IT WAS CRUNCHY.","NOM NOM NOM NOM NOM NOM NOM NOM.","DO NOT PUT YOUR HAND IN ME. PUT A LINK IN ME.","I HAVE TEETH WHERE MY LID SHOULD BE. WHAT OF IT.","YOU LOOK CRUNCHY. JUST AN OBSERVATION.","I DREAM OF LONGREADS. 10,000 WORDS. MMMMM."];
var g=document.getElementById("growl");if(g&&Math.random()<0.75)g.textContent=GROWLS[Math.floor(Math.random()*GROWLS.length)];
if(location.pathname.endsWith("/add"))history.replaceState(null,"",${JSON.stringify(`${base}/`).replace(/</g, "\\u003c")}+location.hash);
if("serviceWorker" in navigator)navigator.serviceWorker.register("${esc(base)}/sw.js").catch(()=>{})</script></body></html>`;
}

// ---------- Read (the kept text) ----------

/** read/<id> is a page to read. read/<id>.md is the raw text. read/<id>.pdf is the original PDF. */
async function serveRead(env: Env, origin: string, name: string): Promise<Response> {
	const id = name.replace(/\.(md|pdf)$/, "");
	if (name.endsWith(".pdf")) {
		const obj = await env.AUDIO.get(pdfKey(id));
		if (!obj) return new Response("Not found", { status: 404 });
		return new Response(obj.body, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${id}.pdf"`, "Cache-Control": "private, max-age=86400" } });
	}
	const [obj, item] = await Promise.all([env.AUDIO.get(readKey(id)), loadItem(env, id)]);
	if (!obj) return new Response("Not found", { status: 404 });
	const md = await obj.text();
	if (name.endsWith(".md")) return new Response(md, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
	return html(readPage(env, origin, id, item, md));
}

function readPage(env: Env, origin: string, id: string, item: Item | null, md: string): string {
	const base = `${origin}/${env.TOKEN}`;
	const title = (item?.title?.replace(/ \(Part \d+ of \d+\)$/, "") || md.match(/^#\s+(.+)$/m)?.[1] || "Some text").trim();
	const meta = [item?.byline && `By ${item.byline}`, item?.site, item && new Date(item.created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }), item?.words && `${item.words.toLocaleString("en-GB")} words`].filter(Boolean).join(" · ");
	const links = [
		`<a href="${esc(base)}/#abyss">← 🕳️ ABYSS</a>`,
		item?.status === "done" && !item.gone && `<a href="${esc(`${base}/audio/${id}.mp3`)}">Play</a>`,
		item?.url && `<a href="${esc(item.url)}">Source</a>`,
		item?.pdf && `<a href="${esc(`${base}/read/${id}.pdf`)}">PDF</a>`,
		`<a href="${esc(`${base}/read/${id}.md`)}">Markdown</a>`,
	].filter(Boolean);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="${esc(base)}/icon-192.png">
<style>
:root{--bg:#fbf6ec;--ink:#20293c;--muted:#6b4226;--link:#0b5f78;--rule:#e8cf9f}
@media (prefers-color-scheme:dark){:root{--bg:#161a21;--ink:#ece6d8;--muted:#e8cf9f;--link:#5fd8e6;--rule:#3a404c}}
html{background:var(--bg)}body{margin:0;padding:24px 16px 64px;color:var(--ink);background:var(--bg);font:19px/1.6 Georgia,"Iowan Old Style",serif}
main{max-width:680px;margin:0 auto}nav{display:flex;flex-wrap:wrap;gap:16px;font:600 15px system-ui,sans-serif;margin-bottom:24px}a{color:var(--link)}
h1{font-size:34px;line-height:1.15;margin:0 0 8px}h2,h3,h4{line-height:1.25;margin:1.6em 0 .4em}.meta{color:var(--muted);font:14px system-ui,sans-serif;margin:0 0 28px;padding-bottom:16px;border-bottom:2px solid var(--rule)}
blockquote{margin:1em 0;padding-left:16px;border-left:3px solid var(--rule)}pre{white-space:pre-wrap;font-size:14px;background:rgba(0,0,0,.05);padding:12px;border-radius:8px}li{margin:.3em 0}img{max-width:100%}
</style></head><body><main><nav>${links.join("")}</nav><h1>${esc(title)}</h1>${meta ? `<p class="meta">${esc(meta)}</p>` : ""}
${markdownToHtml(md.replace(/^#\s+.+\n+/, ""))}
</main></body></html>`;
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
	const title = "Podchast";
	return JSON.stringify({
		name: title,
		short_name: title,
		start_url: "./",
		scope: "./",
		display: "standalone",
		background_color: "#1b9fb0",
		theme_color: "#1b9fb0",
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
	if (!parts.length || !safeEqual(parts[0], env.TOKEN)) return new Response("Not found", { status: 404 });
	const [, a, b] = parts;
	if (!a) return html(statusPage(env, url.origin, await listItems(env)));
	// noises.xml is the main feed URL. feed.xml still works for old subscriptions.
	if (a === FEED || a === "feed.xml" || a === "feed")
		return new Response(feedXml(env, url.origin, await listItems(env), a === "feed" ? "feed.xml" : a), {
			headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "private, max-age=300" },
		});
	if (a === "cover.jpg" || a === "cover.png") return coverResponse();
	if (a === "audio" && b === `${FAILED_ID}.mp3`) await failureClip(env).catch(() => null);
	if (a === "audio" && b?.endsWith(".mp3")) return serveAudio(env, req, b.slice(0, -4));
	if (a === "manifest.webmanifest") return new Response(manifest(env), { headers: { "Content-Type": "application/manifest+json" } });
	if (a === "sw.js") return new Response('self.addEventListener("fetch", () => {});', { headers: { "Content-Type": "text/javascript" } });
	if (a === "icon-180.png") return png(icon180);
	if (a === "icon-192.png") return png(icon192);
	if (a === "icon-512.png") return png(icon512);
	if (a === "delete" && b && b !== FAILED_ID && req.method === "POST") {
		await env.AUDIO.delete([itemKey(b), audioKey(b), partKey(b), readKey(b), pdfKey(b)]);
		return Response.redirect(`${url.origin}/${env.TOKEN}`, 303);
	}
	if (a === "read" && b) return serveRead(env, url.origin, b);
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
		await addItem(env, add);
		return html(statusPage(env, url.origin, await listItems(env), `OM NOM NOM! In my mouth: ${add.content ? (add.title ?? "a big pile of text") : add.target} 😋 Chewing soon.`));
	}
	if (a === "retry" && b) {
		const item = await loadItem(env, b);
		if (!item) return new Response("Not found", { status: 404 });
		item.status = "queued";
		item.error = undefined;
		await saveItem(env, item);
		await env.JOBS.send({ id: item.id });
		if (wantsHtml(req)) return Response.redirect(`${url.origin}/${env.TOKEN}`, 303);
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
	const item = await addItem(env, add);
	const what = add.content ? `${add.title ?? "a big pile of text"} (${add.content.length.toLocaleString("en-GB")} characters)` : add.target;
	return reply(req, 200, `OM NOM NOM! SWALLOWED: ${what} 😋🦷 Burping it into your feed soon.`, { id: item.id });
}

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

// ---------- Queue consumer ----------

const MAX_ATTEMPTS = 3;

/** Debug job: speak one sentence with one engine and save the result under debug/. */
async function debugJob(env: Env, job: Job): Promise<void> {
	const engine = job.debug as "edge" | "workers-ai";
	const name = /^[\w-]{1,40}$/.test(job.id) ? job.id : engine;
	const start = Date.now();
	const report: Record<string, unknown> = { engine, format: job.format, pause: job.pause, at: new Date().toISOString() };
	try {
		const tts = { ...env, TTS_ENGINE: engine === "edge" ? "edge-only" : "workers-ai" };
		if (job.format) tts.EDGE_FORMAT = job.format;
		if (job.pause !== undefined) tts.EDGE_PAUSE_MS = String(job.pause);
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
	const item = await loadItem(env, job.id);
	if (!item || (item.status === "done" && !job.force)) return;
	item.status = "processing";
	// Re-chomp of 🍖 MEAT: read the kept text again, and split it again if it is long.
	if (item.gone && (item.part ?? 1) === 1) {
		item.part = undefined;
		item.parts = undefined;
	}
	await saveItem(env, item);
	try {
		const { text, headings } = item.part ? await partText(env, item) : await firstPart(env, item);
		const partNote = item.parts ? ` Part ${item.part} of ${item.parts}.` : "";
		const intro = [item.title?.replace(/[.!?]?$/, "."), item.byline && `By ${item.byline}.`, item.site && `From ${item.site}.`].filter(Boolean).join(" ") + partNote;
		const outro = item.parts && item.part !== item.parts ? `End of part ${item.part}. Part ${(item.part ?? 1) + 1} follows.` : "End of article.";
		const script = `${intro}\n\n${text}\n\n${outro}`;
		item.chars = script.length;
		item.words = text.split(/\s+/).filter(Boolean).length;
		const { mp3, engine, edgeError, marks } = await speak(env, script);
		const seconds = mp3Duration(mp3);
		// Chapters: the article start, then one for each heading.
		const chapters: Chapter[] = [{ title: item.title ?? "Start", start: 0 }];
		for (const h of headings) {
			const start = marks(h);
			if (start !== undefined && start > chapters[chapters.length - 1].start + 1) chapters.push({ title: h.replace(/\.$/, ""), start });
		}
		const audio = concat([id3Tag(item.title ?? "Podchast", chapters, seconds), mp3]);
		await env.AUDIO.put(audioKey(item.id), audio, { httpMetadata: { contentType: "audio/mpeg" } });
		item.bytes = audio.length;
		item.duration = seconds;
		item.chapters = chapters.length >= 2 ? chapters.length : undefined;
		item.engine = engine;
		item.error = edgeError ? `Edge TTS failed, used Workers AI: ${edgeError}` : undefined;
		item.status = "done";
		if (item.gone) {
			item.gone = undefined;
			item.aired = new Date().toISOString();
		}
		await saveItem(env, item);
		if (item.parts || item.text) await env.AUDIO.delete(partKey(item.id));
	} catch (e) {
		const msg = String((e as Error)?.message ?? e);
		console.error(`Job ${item.id} attempt ${attempt} failed:`, msg);
		item.error = msg;
		item.status = attempt >= MAX_ATTEMPTS ? "failed" : "queued";
		if (item.status === "failed") await addFailureClip(env, item);
		await saveItem(env, item);
		if (attempt < MAX_ATTEMPTS) throw e;
	}
}

/** Fetch the article for a new item. If it is long, queue parts 2..n as their own items and return the text for part 1. */
async function firstPart(env: Env, item: Item): Promise<PartText> {
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
	const headings = art.headings ?? [];
	const n = Math.ceil(art.text.length / PART_CHARS);
	if (n <= 1) return { text: art.text, headings };
	// Balanced parts, split at paragraph or sentence breaks.
	const chunks = chunkText(art.text, Math.ceil((art.text.length / n) * 1.05));
	const parts = chunks.length;
	// Later parts get later dates. A re-chomp starts from now, so the parts are new in the feed.
	const created = item.gone ? Date.now() : Date.parse(item.created);
	const partOf = (t: string): PartText => ({ text: t, headings: headings.filter((h) => t.includes(h)) });
	for (let i = 1; i < parts; i++) {
		// Later parts get later dates, so podcast apps list them in order.
		const at = new Date(created + i * 1000).toISOString();
		const p: Item = { ...item, id: `${item.id}-p${i + 1}`, part: i + 1, parts, status: "queued", created: item.gone ? ((await loadItem(env, `${item.id}-p${i + 1}`))?.created ?? at) : at, pdf: undefined };
		if (item.gone) p.aired = at;
		p.title = `${art.title} (Part ${i + 1} of ${parts})`;
		await env.AUDIO.put(partKey(p.id), JSON.stringify(partOf(chunks[i])));
		await saveItem(env, p);
		await env.JOBS.send({ id: p.id });
	}
	item.part = 1;
	item.parts = parts;
	// Keep part 1's text too, so a retry does not split the article again.
	await env.AUDIO.put(partKey(item.id), JSON.stringify(partOf(chunks[0])));
	item.title = `${art.title} (Part 1 of ${parts})`;
	return partOf(chunks[0]);
}

/** Turn a PDF into markdown with Workers AI (free for PDFs). Page headings are dropped, so they do not become chapters. */
async function pdfMarkdown(env: Env, name: string, bytes: ArrayBuffer | Uint8Array): Promise<string> {
	const res = await env.AI.toMarkdown({ name, blob: new Blob([bytes], { type: "application/pdf" }) }, { conversionOptions: { pdf: { metadata: false } } } as any);
	if (res.format === "error") throw new Error(`Could not read the PDF: ${(res as any).error ?? "unknown error"}`);
	return res.data
		.split("\n")
		.filter((l) => !/^#{1,6}\s*(Page \d+|Contents|Metadata)\s*$/i.test(l.trim()))
		.join("\n");
}

async function pdfArticle(env: Env, bytes: ArrayBuffer, url: string): Promise<Article> {
	const file = decodeURIComponent(new URL(url).pathname.split("/").pop() || "document.pdf");
	const { text, headings, h1 } = markdownToSpeech(await pdfMarkdown(env, file, bytes));
	if (!text) throw new Error("The PDF has no text I can read (it may be scanned images)");
	return { title: h1 || file.replace(/\.pdf$/i, ""), text, headings, site: new URL(url).hostname.replace(/^www\./, "") };
}

/** Read text that was sent to /add. Markdown is made plain, and its headings become chapters. */
async function textArticle(env: Env, item: Item): Promise<Article> {
	// Older items kept their text in parts/ until the job read it.
	const obj = (await env.AUDIO.get(readKey(item.id))) ?? (await env.AUDIO.get(partKey(item.id)));
	if (!obj) throw new Error("The text is missing");
	const { text, headings, h1 } = markdownToSpeech(await obj.text());
	if (!text) throw new Error("The text was empty after I took out the markdown");
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
	if (!obj) throw new Error(`Text for part ${item.part} is missing`);
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

const FAILED_ID = "failed-v2";

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
		item.duration = head ? Math.round((head.size * 8) / 48000) : undefined;
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
				msg.retry({ delaySeconds: 60 * msg.attempts });
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
			if (!addProblem(add)) added.push((await addItem(env, add)).id);
		}
		if (!mail.pdfs.length) {
			// A short body with a link means "eat this link". Anything longer is the text itself.
			const target = findUrl(mail.text);
			const rest = mail.text.replace(/https?:\/\/\S+/g, "").trim();
			const add: AddRequest =
				target && rest.length < 300 ? { token: "", target, title: undefined } : { token: "", target: null, content: mail.text, title: subject || undefined };
			if (!addProblem(add)) added.push((await addItem(env, add)).id);
		}
		console.log(`Email: added ${added.length} item(s) ${added.join(", ")}`);
		if (!added.length) message.setReject("BLEH. That email had nothing I could eat. 😤");
	},
} satisfies ExportedHandler<Env, Job>;
