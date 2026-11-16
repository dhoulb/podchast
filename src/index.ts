import { coverPng } from "./cover";
import { fetchArticle } from "./extract";
import { mp3Duration, speak, type TtsEnv } from "./tts";

export interface Env extends TtsEnv {
	AUDIO: R2Bucket;
	JOBS: Queue<Job>;
	TOKEN: string; // Secret. Guards /add and is part of the feed URL.
	FEED_TITLE: string;
	RETENTION_DAYS: string;
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
};

// ---------- Storage (R2 only) ----------
// items/<id>  JSON item, also copied into customMetadata so one list() call builds the feed.
// audio/<id>.mp3

const itemKey = (id: string) => `items/${id}`;
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
	let raw = url.searchParams.get("url") ?? "";
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
		.filter((i) => i.status === "done")
		.map((i) => {
			const desc = [i.excerpt, i.byline && `By ${i.byline}.`, `Source: ${i.url}`].filter(Boolean).join("\n\n");
			const name = i.site ? `${i.title} (${i.site})` : (i.title ?? i.url);
			return `<item>
<title>${esc(name)}</title>
<link>${esc(i.url)}</link>
<guid isPermaLink="false">${esc(i.id)}</guid>
<pubDate>${new Date(i.updated ?? i.created).toUTCString()}</pubDate>
<description>${esc(desc)}</description>
<enclosure url="${esc(`${base}/audio/${i.id}.mp3`)}" length="${i.bytes ?? 0}" type="audio/mpeg"/>
<itunes:duration>${hms(i.duration)}</itunes:duration>
${i.byline ? `<itunes:author>${esc(i.byline)}</itunes:author>` : ""}
<itunes:explicit>false</itunes:explicit>
</item>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${esc(title)}</title>
<link>${esc(base)}</link>
<atom:link href="${esc(`${base}/feed.xml`)}" rel="self" type="application/rss+xml"/>
<description>Articles read aloud. Episodes disappear after ${Number(env.RETENTION_DAYS) || 30} days.</description>
<language>en</language>
<itunes:author>${esc(title)}</itunes:author>
<itunes:image href="${esc(`${base}/cover.png`)}"/>
<image><url>${esc(`${base}/cover.png`)}</url><title>${esc(title)}</title><link>${esc(base)}</link></image>
<itunes:block>Yes</itunes:block>
<itunes:explicit>false</itunes:explicit>
<itunes:category text="News"/>
${entries}
</channel>
</rss>`;
}


function statusPage(env: Env, origin: string, items: Item[], note = ""): string {
	const base = `${origin}/${env.TOKEN}`;
	const rows = items
		.map(
			(i) => `<li><b>${esc(i.title ?? i.url)}</b><br><small>${esc(i.status)}${i.duration ? ` · ${hms(i.duration)}` : ""}${i.engine ? ` · ${esc(i.engine)}` : ""} · ${esc(new Date(i.created).toUTCString())} · <a href="${esc(i.url)}">source</a>${i.status === "done" ? ` · <a href="${esc(`${base}/audio/${i.id}.mp3`)}">mp3</a>` : ""}${i.error ? `<br>Error: ${esc(i.error)}` : ""}</small></li>`,
		)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(env.FEED_TITLE || "Podchast")}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:16px}input[type=url]{width:100%;padding:8px;font:inherit;box-sizing:border-box}button{margin-top:8px;padding:8px 16px;font:inherit}li{margin:12px 0}small{color:#666}code{word-break:break-all}</style></head><body>
<h1>${esc(env.FEED_TITLE || "Podchast")}</h1>
${note ? `<p><b>${esc(note)}</b></p>` : ""}
<form method="post" action="${esc(base)}/add"><input type="url" name="url" placeholder="https://example.com/article" required><button>Add article</button></form>
<p>Podcast feed: <code>${esc(base)}/feed.xml</code></p>
<ul>${rows || "<li>No items yet.</li>"}</ul></body></html>`;
}

async function handleFetch(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const parts = url.pathname.split("/").filter(Boolean);
	if (!env.TOKEN) return new Response("TOKEN secret is not set", { status: 500 });

	// POST /add (token in header, query or body) — used by the iOS Shortcut.
	if (parts[0] === "add" && parts.length === 1) {
		const { token, target } = await readAddRequest(req, url);
		if (!safeEqual(token, env.TOKEN)) return new Response("Unauthorised", { status: 401 });
		if (!target) return new Response("No URL found", { status: 400 });
		const item = await addUrl(env, target);
		return Response.json({ ok: true, id: item.id, message: `Queued: ${target}` });
	}

	// Everything else lives under /<token>/...
	if (!parts.length || !safeEqual(parts[0], env.TOKEN)) return new Response("Not found", { status: 404 });
	const [, a, b] = parts;
	if (!a) return html(statusPage(env, url.origin, await listItems(env)));
	if (a === "feed.xml" || a === "feed")
		return new Response(feedXml(env, url.origin, await listItems(env)), {
			headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "private, max-age=300" },
		});
	if (a === "cover.png") return new Response(await coverPng(), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
	if (a === "audio" && b?.endsWith(".mp3")) return serveAudio(env, req, b.slice(0, -4));
	if (a === "add") {
		const { target } = await readAddRequest(req, url);
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
		return Response.json({ ok: true });
	}
	return new Response("Not found", { status: 404 });
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
		const art = await fetchArticle(item.url);
		item.title = art.title;
		item.byline = art.byline;
		item.site = art.site;
		item.excerpt = art.excerpt ?? art.text.slice(0, 300);
		const intro = [art.title.replace(/[.!?]?$/, "."), art.byline && `By ${art.byline}.`, art.site && `From ${art.site}.`].filter(Boolean).join(" ");
		const script = `${intro}\n\n${art.text}\n\nEnd of article.`;
		item.chars = script.length;
		const { mp3, engine, edgeError } = await speak(env, script);
		await env.AUDIO.put(audioKey(item.id), mp3, { httpMetadata: { contentType: "audio/mpeg" } });
		item.bytes = mp3.length;
		item.duration = mp3Duration(mp3);
		item.engine = engine;
		item.error = edgeError ? `Edge TTS failed, used Workers AI: ${edgeError}` : undefined;
		item.status = "done";
		await saveItem(env, item);
	} catch (e) {
		const msg = String((e as Error)?.message ?? e);
		console.error(`Job ${item.id} attempt ${attempt} failed:`, msg);
		item.error = msg;
		item.status = attempt >= MAX_ATTEMPTS ? "failed" : "queued";
		await saveItem(env, item);
		if (attempt < MAX_ATTEMPTS) throw e;
	}
}

export default {
	fetch: (req, env) =>
		handleFetch(req, env).catch((e) => {
			console.error(e);
			return new Response("Server error", { status: 500 });
		}),

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
		for (const prefix of ["items/", "audio/"]) {
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
