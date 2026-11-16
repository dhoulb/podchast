import cover from "../assets/cover.jpg";
import icon180 from "../assets/icon-180.png";
import icon192 from "../assets/icon-192.png";
import icon512 from "../assets/icon-512.png";
import { chunkText, fetchArticle } from "./extract";
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
}

type Job = { id: string; debug?: "edge" | "workers-ai" | "extract"; url?: string; force?: boolean };

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
};

// Text for one episode, with the headings that become chapters.
type PartText = { text: string; headings: string[] };

// ---------- Storage (R2 only) ----------
// items/<id>  JSON item, also copied into customMetadata so one list() call builds the feed.
// audio/<id>.mp3

// parts/<id>.txt  Text for one part of a long article, deleted when that part is done.

const itemKey = (id: string) => `items/${id}`;
const partKey = (id: string) => `parts/${id}.txt`;

// Articles longer than this are split into several episodes (about 40 minutes each).
// Each part is its own queue job, so each part gets its own subrequest and time limits.
const PART_CHARS = 40_000;
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
	const cutoff = Date.now() - retentionMs(env);
	return items.filter((i) => Date.parse(i.created) > cutoff).sort((a, b) => b.created.localeCompare(a.created));
}

const retentionMs = (env: Env) => (Number(env.RETENTION_DAYS) || 30) * 86400_000;

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

async function readAddRequest(req: Request, url: URL): Promise<{ token: string; target: string | null }> {
	let token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-token") || url.searchParams.get("token") || "";
	// Android's share target sends the link as url, text or title.
	let raw = url.searchParams.get("url") || url.searchParams.get("text") || url.searchParams.get("title") || "";
	if (req.method === "POST") {
		const type = req.headers.get("content-type") ?? "";
		if (type.includes("application/json")) {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
			raw = String(body.url ?? body.text ?? body.input ?? raw);
			token ||= String(body.token ?? "");
		} else if (type.includes("form")) {
			const form = await req.formData();
			raw = String(form.get("url") ?? raw);
			token ||= String(form.get("token") ?? "");
		} else {
			raw = (await req.text()) || raw;
		}
	}
	return { token, target: findUrl(raw) };
}

async function addUrl(env: Env, target: string): Promise<Item> {
	const item: Item = { id: newId(), url: target, status: "queued", created: new Date().toISOString() };
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

function feedXml(env: Env, origin: string, items: Item[]): string {
	const base = `${origin}/${env.TOKEN}`;
	const title = env.FEED_TITLE || "Podchast";
	const entries = items
		.filter((i) => i.status === "done" || i.status === "failed")
		.map((i) => {
			const failed = i.status === "failed";
			const article = i.title ?? i.url;
			const name = failed ? `Failed: ${article}` : i.site ? `${i.title} (${i.site})` : article;
			const facts = failed
				? []
				: [i.words && `${i.words.toLocaleString("en-GB")} words`, i.duration && `${Math.round(i.duration / 60)} min`, i.chapters && `${i.chapters} chapters`].filter(Boolean);
			const notes = failed
				? [`<p>Podchast could not read this article.</p>`, `<p>Reason: ${esc(i.error ?? "unknown")}</p>`, `<p><a href="${esc(i.url)}">Open the article</a></p>`, `<p>Share the link again to retry.</p>`]
				: [
						i.excerpt && `<p>${esc(i.excerpt)}</p>`,
						i.byline && `<p>By ${esc(i.byline)}.</p>`,
						`<p><a href="${esc(i.url)}">Read the article</a>${i.site ? ` on ${esc(i.site)}` : ""}</p>`,
						facts.length && `<p>${esc(facts.join(" · "))}</p>`,
					].filter(Boolean);
			const plain = failed ? `Podchast could not read this article. Reason: ${i.error ?? "unknown"}. ${i.url}` : [i.excerpt, i.byline && `By ${i.byline}.`, `Source: ${i.url}`, facts.join(" · ")].filter(Boolean).join("\n\n");
			const audio = failed ? `${base}/audio/${FAILED_ID}.mp3?for=${i.id}` : `${base}/audio/${i.id}.mp3`;
			return `<item>
<title>${esc(name)}</title>
<link>${esc(i.url)}</link>
<guid isPermaLink="false">${esc(i.id)}</guid>
<pubDate>${new Date(i.created).toUTCString()}</pubDate>
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
<atom:link href="${esc(`${base}/feed.xml`)}" rel="self" type="application/rss+xml"/>
<description>Articles read aloud. Episodes disappear after ${Number(env.RETENTION_DAYS) || 30} days.</description>
<language>en</language>
<itunes:author>${esc(title)}</itunes:author>
<itunes:image href="${esc(`${base}/cover.jpg?v=3`)}"/>
<image><url>${esc(`${base}/cover.jpg?v=3`)}</url><title>${esc(title)}</title><link>${esc(base)}</link></image>
<itunes:explicit>false</itunes:explicit>
<itunes:category text="News"/>
${entries}
</channel>
</rss>`;
}


const STATUS_LABEL: Record<Status, string> = { queued: "Queued", processing: "Reading aloud", done: "Ready", failed: "Failed" };

function statusPage(env: Env, origin: string, items: Item[], note = ""): string {
	const base = `${origin}/${env.TOKEN}`;
	const title = env.FEED_TITLE || "Podchast";
	const rows = items
		.map((i) => {
			const meta = [i.duration && hms(i.duration), i.words && `${i.words.toLocaleString("en-GB")} words`, i.chapters && `${i.chapters} chapters`, i.site, new Date(i.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })].filter(Boolean);
			return `<li class="card">
<div class="row"><span class="pill ${i.status}">${STATUS_LABEL[i.status]}</span><span class="meta">${esc(meta.join(" · "))}</span></div>
<h3>${esc(i.title ?? i.url)}</h3>
${i.error ? `<p class="err">${esc(i.error)}</p>` : ""}
<div class="row actions"><a href="${esc(i.url)}">Article</a>${i.status === "done" ? `<a href="${esc(`${base}/audio/${i.id}.mp3`)}">Listen</a>` : ""}${i.status === "failed" ? `<form method="post" action="${esc(`${base}/retry/${i.id}`)}"><button class="link">Retry</button></form>` : ""}
<form method="post" action="${esc(`${base}/delete/${i.id}`)}" onsubmit="return confirm('Delete this episode?')"><button class="link danger">Delete</button></form></div>
</li>`;
		})
		.join("");
	const shortcut = env.SHORTCUT_URL
		? `<section class="panel"><h2>Share from iPhone</h2><p>Tap <b>Copy my add URL</b>, then <b>Add to share sheet</b>. Paste the URL when Shortcuts asks.</p>
<div class="row"><button type="button" class="btn" onclick="navigator.clipboard.writeText('${esc(base)}/add').then(()=>this.textContent='Copied!')">Copy my add URL</button><a class="btn gold" href="${esc(env.SHORTCUT_URL)}">Add to share sheet</a></div></section>`
		: "";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<link rel="manifest" href="${esc(base)}/manifest.webmanifest"><link rel="apple-touch-icon" href="${esc(base)}/icon-180.png"><link rel="icon" href="${esc(base)}/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="${esc(title)}"><meta name="theme-color" content="#0392b4">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;700&display=swap" rel="stylesheet">
<style>
:root{--teal:#05aabe;--teal-d:#0392b4;--teal-dd:#0b5f78;--ink:#20293c;--parch:#f7e6c4;--parch-d:#e8cf9f;--wood:#6b4226;--iron:#3d4450;--gold:#f2b632;--ember:#ff7a1a;--red:#c8323c;--green:#2f9e5b}
*{box-sizing:border-box}
html{background:var(--teal-d)}
body{margin:0;min-height:100vh;font:16px/1.5 system-ui,-apple-system,sans-serif;color:var(--ink);background:radial-gradient(circle at 50% 0,#22c3d4 0,var(--teal) 35%,var(--teal-d) 100%) fixed;padding:env(safe-area-inset-top) 16px 48px}
main{max-width:720px;margin:0 auto}
header{display:flex;align-items:center;gap:16px;padding:24px 0 16px}
header img{width:84px;height:84px;border-radius:20px;border:4px solid var(--iron);box-shadow:0 6px 0 rgba(0,0,0,.25)}
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
form.add{display:flex;gap:8px;flex-wrap:wrap}form.add input{flex:1 1 260px}
code{display:block;word-break:break-all;background:#fffaf0;border:2px dashed var(--parch-d);border-radius:8px;padding:8px;font-size:13px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}
.card{padding:12px 14px}
.card h3{margin:6px 0;font-size:19px;line-height:1.25;color:var(--ink)}
.meta{color:var(--wood);font-size:14px}
.pill{font-size:13px;font-weight:700;padding:2px 10px;border-radius:999px;border:2px solid var(--ink);background:#fff}
.pill.done{background:var(--green);color:#fff}.pill.processing{background:var(--ember);color:#fff}.pill.queued{background:var(--gold)}.pill.failed{background:var(--red);color:#fff}
.err{margin:4px 0;color:var(--red);font-size:14px}
.actions a,button.link{font:inherit;font-size:15px;font-weight:600;color:var(--teal-dd);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.actions{gap:14px;margin-top:4px}.actions form{display:inline}
button.danger{color:var(--red)}
.empty{text-align:center;color:var(--wood)}
@media (prefers-color-scheme:dark){html{background:#04222c}:root{--parch:#2a2f3a;--parch-d:#444b59;--ink:#f3ead6;--wood:#e8cf9f;--teal-dd:#5fd8e6}body{background:radial-gradient(circle at 50% 0,#0b6f86 0,#06485a 45%,#04222c 100%) fixed}input[type=url],code{background:#1d222b;color:var(--ink)}.pill{color:#20293c}.pill.done,.pill.processing,.pill.failed{color:#fff}.btn,button.btn{border-color:#20293c;box-shadow:0 4px 0 #000}.btn.gold{color:#20293c}h1{-webkit-text-stroke-color:#20293c;text-shadow:0 4px 0 #000}.note{color:#20293c}}
</style></head><body><main>
<header><img src="${esc(base)}/icon-192.png" alt=""><div><h1>${esc(title)}</h1><p>Articles in. Audio out. Gone in ${Number(env.RETENTION_DAYS) || 30} days.</p></div></header>
${note ? `<section class="panel note">${esc(note)}</section>` : ""}
<section class="panel"><h2>Add an article</h2><form class="add" method="post" action="${esc(base)}/add"><input type="url" name="url" placeholder="https://example.com/article" required><button class="btn gold">Add</button></form></section>
${shortcut}
<section class="panel"><h2>Podcast feed</h2><p>Add this to your podcast app with "Follow by URL".</p><code>${esc(base)}/feed.xml</code><div class="row" style="margin-top:10px"><button type="button" class="btn" onclick="navigator.clipboard.writeText('${esc(base)}/feed.xml').then(()=>this.textContent='Copied!')">Copy feed URL</button></div></section>
<ul>${rows || `<li class="card empty">Nothing yet. Share an article to start.</li>`}</ul>
</main>
<script>if("serviceWorker" in navigator)navigator.serviceWorker.register("${esc(base)}/sw.js").catch(()=>{})</script></body></html>`;
}

/** Web app manifest. On Android, installing the status page adds Podchast to the share menu. */
function manifest(env: Env): string {
	const title = env.FEED_TITLE || "Podchast";
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
		const { token, target } = await readAddRequest(req, url);
		if (!safeEqual(token, env.TOKEN)) return reply(req, 401, "Podchast: wrong or missing token.");
		return queueReply(req, env, target);
	}

	// Everything else lives under /<token>/...
	if (!parts.length || !safeEqual(parts[0], env.TOKEN)) return new Response("Not found", { status: 404 });
	const [, a, b] = parts;
	if (!a) return html(statusPage(env, url.origin, await listItems(env)));
	if (a === "feed.xml" || a === "feed")
		return new Response(feedXml(env, url.origin, await listItems(env)), {
			headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "private, max-age=300" },
		});
	if (a === "cover.jpg" || a === "cover.png") return new Response(cover, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800" } });
	if (a === "audio" && b === `${FAILED_ID}.mp3`) await failureClip(env).catch(() => null);
	if (a === "audio" && b?.endsWith(".mp3")) return serveAudio(env, req, b.slice(0, -4));
	if (a === "manifest.webmanifest") return new Response(manifest(env), { headers: { "Content-Type": "application/manifest+json" } });
	if (a === "sw.js") return new Response('self.addEventListener("fetch", () => {});', { headers: { "Content-Type": "text/javascript" } });
	if (a === "icon-180.png") return png(icon180);
	if (a === "icon-192.png") return png(icon192);
	if (a === "icon-512.png") return png(icon512);
	if (a === "delete" && b && b !== FAILED_ID && req.method === "POST") {
		await env.AUDIO.delete([itemKey(b), audioKey(b), partKey(b)]);
		return Response.redirect(`${url.origin}/${env.TOKEN}`, 303);
	}
	if (a === "add") {
		const { target } = await readAddRequest(req, url);
		// The status page form posts here from a browser. Shortcuts and scripts get a short text reply.
		if (!wantsHtml(req)) return queueReply(req, env, target);
		if (!target) return new Response("No URL found", { status: 400 });
		await addUrl(env, target);
		return html(statusPage(env, url.origin, await listItems(env), `Queued: ${target}`));
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

async function queueReply(req: Request, env: Env, target: string | null): Promise<Response> {
	if (!target) return reply(req, 400, "Podchast: no link found. Share a web page or copy a link first.");
	const item = await addUrl(env, target);
	return reply(req, 200, `Added to Podchast: ${target}`, { id: item.id });
}

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

// ---------- Queue consumer ----------

const MAX_ATTEMPTS = 3;

/** Debug job: speak one sentence with one engine and save the result under debug/. */
async function debugJob(env: Env, engine: "edge" | "workers-ai"): Promise<void> {
	const start = Date.now();
	const report: Record<string, unknown> = { engine, at: new Date().toISOString() };
	try {
		const { mp3, engine: used } = await speak({ ...env, TTS_ENGINE: engine === "edge" ? "edge-only" : "workers-ai" }, "Hello. This is a test of Podchast, running on Cloudflare.");
		await env.AUDIO.put(`debug/${engine}.mp3`, mp3, { httpMetadata: { contentType: "audio/mpeg" } });
		Object.assign(report, { ok: true, used, bytes: mp3.length, duration: mp3Duration(mp3) });
	} catch (e) {
		Object.assign(report, { ok: false, error: String((e as Error)?.stack ?? e) });
	}
	report.ms = Date.now() - start;
	await env.AUDIO.put(`debug/${engine}.json`, JSON.stringify(report, null, 1));
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
			const at = html.search(/<p[ >]/i);
			Object.assign(report, { status: r.status, type: r.headers.get("content-type"), length: html.length, pCount: (html.match(/<p[ >]/gi) ?? []).length, firstP: at >= 0 ? html.slice(Math.max(0, at - 300), at + 500) : html.slice(0, 800) });
		} catch {}
	}
	await env.AUDIO.put(`debug/extract-${id}.json`, JSON.stringify(report, null, 1));
}

async function processJob(env: Env, job: Job, attempt: number): Promise<void> {
	if (job.debug === "extract") return debugExtract(env, job.id, job.url ?? "");
	if (job.debug) return debugJob(env, job.debug);
	const item = await loadItem(env, job.id);
	if (!item || (item.status === "done" && !job.force)) return;
	item.status = "processing";
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
		await saveItem(env, item);
		if (item.parts) await env.AUDIO.delete(partKey(item.id));
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
	const art = await fetchArticle(item.url);
	item.title = art.title;
	item.byline = art.byline;
	item.site = art.site;
	item.excerpt = art.excerpt ?? art.text.slice(0, 300);
	item.image = art.image && art.image.length <= 400 ? art.image : undefined;
	const headings = art.headings ?? [];
	const n = Math.ceil(art.text.length / PART_CHARS);
	if (n <= 1) return { text: art.text, headings };
	// Balanced parts, split at paragraph or sentence breaks.
	const chunks = chunkText(art.text, Math.ceil((art.text.length / n) * 1.05));
	const parts = chunks.length;
	const created = Date.parse(item.created);
	const partOf = (t: string): PartText => ({ text: t, headings: headings.filter((h) => t.includes(h)) });
	for (let i = 1; i < parts; i++) {
		// Later parts get later dates, so podcast apps list them in order.
		const p: Item = { ...item, id: `${item.id}-p${i + 1}`, part: i + 1, parts, status: "queued", created: new Date(created + i * 1000).toISOString() };
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

const FAILED_ID = "failed";

/** Make the shared "could not read this article" clip if it does not exist yet. */
async function failureClip(env: Env): Promise<R2Object | null> {
	const head = await env.AUDIO.head(audioKey(FAILED_ID));
	if (head) return head;
	const { mp3 } = await speak(env, "Podchast could not turn this article into audio. The episode notes say why. You can share the link again to try once more.");
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

	// Daily clean-up. The R2 lifecycle rule also deletes old objects; this is a backup.
	async scheduled(_ctl, env) {
		const cutoff = Date.now() - retentionMs(env);
		for (const prefix of ["items/", "audio/", "parts/"]) {
			let cursor: string | undefined;
			do {
				const page = await env.AUDIO.list({ prefix, cursor, limit: 1000 });
				const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
				if (old.length) await env.AUDIO.delete(old);
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
		}
	},
} satisfies ExportedHandler<Env, Job>;
