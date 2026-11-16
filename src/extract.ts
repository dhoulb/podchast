// Article extraction with HTMLRewriter (built into Workers, no dependencies).
// A light "Readability" heuristic: collect text blocks, note which container
// each block sits in (articleBody / article / main / page chrome), then keep
// the best container's blocks.

export type Article = {
	title: string;
	byline?: string;
	site?: string;
	excerpt?: string;
	text: string;
	lang?: string;
	image?: string; // og:image, absolute URL
	headings?: string[]; // Heading paragraphs, exactly as they appear in `text`
};

const UAS = [
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
];

/** Get an article. `pdf` turns a PDF response into an article (the caller has the AI binding). */
export async function fetchArticle(url: string, pdf?: (bytes: ArrayBuffer, url: string) => Promise<Article>): Promise<Article> {
	let resp: Response | undefined;
	// Some sites block one browser identity but not another, so try each.
	for (const ua of UAS) {
		resp = await fetch(url, {
			signal: AbortSignal.timeout(30_000),
			headers: {
				"User-Agent": ua,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-GB,en;q=0.9",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Upgrade-Insecure-Requests": "1",
			},
			redirect: "follow",
		});
		if (resp.ok || ![401, 403, 429, 503].includes(resp.status)) break;
	}
	if (!resp) throw new Error(`${host(url)}: no answer`);
	if (!resp.ok) throw new Error(`${host(url)}: Error ${resp.status} ${resp.statusText || STATUS_TEXT[resp.status] || ""}`.trim());
	const type = resp.headers.get("content-type") ?? "";
	if (pdf && (type.includes("application/pdf") || (/\.pdf(\?|$)/i.test(url) && type.includes("octet-stream")))) return pdf(await resp.arrayBuffer(), resp.url || url);
	if (type.includes("text/plain")) return { title: titleFromUrl(url), text: tidy(await resp.text()), site: host(url) };
	if (!type.includes("html") && type) throw new Error(`${host(url)}: Content-Type ${type}`);
	return extractArticle(resp, resp.url || url);
}

type Block = { tag: string; text: string; body: boolean; article: boolean; main: boolean; chrome: boolean };

const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd";
// React streaming puts late HTML in <div hidden id="S:0"> and moves it into the page with a script (X articles do this). That is not chrome.
const CHROME =
	"nav, header, footer, aside, form, figure, figcaption, button, dialog, menu, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [aria-hidden=true], [hidden]:not([id^='S:']), .comments, #comments, .related, .newsletter, .share, .social, .advert, .ad, .sidebar, .footnotes";
const SKIP = "script, style, noscript, template, svg, math, iframe, select, textarea, sup, pre";
// Text in tables is left out of blocks, but kept for the plain-text fallback (old sites use layout tables).
const TABLE = "table";
const BODY_SEL =
	"[itemprop=articleBody], .article-body, .article__body, .post-content, .entry-content, .post-body, .story-body, .content-body, #article-body, .c-entry-content, .rich-text, .x-article-body";

export async function extractArticle(resp: Response, url: string): Promise<Article> {
	const meta: Record<string, string> = {};
	let titleTag = "";
	let lang: string | undefined;
	const depth = { body: 0, article: 0, main: 0, chrome: 0, skip: 0, title: 0, table: 0, page: 0 };
	// All visible page text, with line breaks, for pages that do not use <p> (e.g. <br><br> paragraphs).
	let plain = "";
	const blocks: Block[] = [];
	let cur: Block | null = null;

	// One element can match several counters (e.g. <svg aria-hidden="true"> is both chrome and skip).
	// An element has only one end tag handler: each onEndTag() call replaces the last one.
	// So each handler closes every counter that this element opened. "*" runs first and starts the list.
	let open: (keyof typeof depth)[] = [];
	const counter = (key: keyof typeof depth) => ({
		element(el: Element) {
			// Self-closing tags (e.g. <path aria-hidden="true"/> in SVG) never get an end tag.
			const e = el as Element & { selfClosing?: boolean; canHaveContent?: boolean };
			if (e.selfClosing === true || e.canHaveContent === false) return;
			depth[key]++;
			const keys = open;
			keys.push(key);
			try {
				el.onEndTag(() => {
					for (const k of keys) depth[k]--;
				});
			} catch {
				depth[key]--; // Void element: no end tag.
				keys.pop();
			}
		},
	});
	const flush = () => {
		if (cur) {
			cur.text = tidy(decodeEntities(cur.text));
			if (cur.text) blocks.push(cur);
		}
		cur = null;
	};

	const rewriter = new HTMLRewriter()
		.on("*", { element: () => void (open = []) })
		.on("html", { element: (el) => void (lang = el.getAttribute("lang") ?? undefined) })
		.on("meta", {
			element(el) {
				const k = el.getAttribute("property") ?? el.getAttribute("name") ?? el.getAttribute("itemprop");
				const v = el.getAttribute("content");
				if (k && v && !(k.toLowerCase() in meta)) meta[k.toLowerCase()] = decodeEntities(v).trim();
			},
		})
		.on("title", counter("title"))
		.on(BODY_SEL, counter("body"))
		.on("article", counter("article"))
		.on("main, [role=main]", counter("main"))
		.on(CHROME, counter("chrome"))
		.on(SKIP, counter("skip"))
		.on(TABLE, counter("table"))
		.on("body", counter("page"))
		.on("br", { element: () => void (plain += "\n") })
		.on("div, td, tr, section, center", { element: () => void (plain += "\n\n") })
		.on(BLOCKS, {
			element(el) {
				const tag = el.tagName.toLowerCase();
				plain += "\n\n";
				if (cur) {
					// Nested block (e.g. <p> inside <li>): keep adding to the outer block,
					// unless the outer one is a <p>, which cannot nest, so it ended.
					if (cur.tag !== "p") {
						cur.text += "\n";
						return;
					}
					flush();
				}
				const b: Block = {
					tag,
					text: "",
					body: depth.body > 0,
					article: depth.article > 0,
					main: depth.main > 0,
					chrome: depth.chrome > 0,
				};
				cur = b;
				try {
					el.onEndTag(() => {
						if (cur === b) flush();
					});
				} catch {}
			},
		})
		.onDocument({
			text(t) {
				if (depth.title > 0) titleTag += t.text;
				else if (depth.skip === 0) {
					if (cur && depth.table === 0) cur.text += t.text;
					if (depth.chrome === 0 && depth.page > 0) plain += t.text;
				}
			},
		});

	await rewriter.transform(resp).arrayBuffer();
	flush();

	const usable = (b: Block) => !b.chrome && (b.text.length >= 30 || /^h\d$/.test(b.tag) || b.tag === "blockquote" || (b.tag === "li" && b.text.length >= 15));
	const pick = (f: (b: Block) => boolean) => blocks.filter((b) => f(b) && usable(b));
	const size = (bs: Block[]) => bs.filter((b) => b.tag === "p").reduce((n, b) => n + b.text.length, 0);
	let chosen = pick((b) => b.body);
	if (size(chosen) < 500) chosen = pick((b) => b.article);
	if (size(chosen) < 500) chosen = pick((b) => b.main);
	// If page-chrome tracking went wrong (e.g. an unclosed tag), ignore it for <article> and <main>.
	const loose = (f: (b: Block) => boolean) => blocks.filter((b) => f(b) && usable({ ...b, chrome: false }) && b.tag !== "li");
	if (size(chosen) < 500) chosen = loose((b) => b.article);
	if (size(chosen) < 500) chosen = loose((b) => b.main);
	if (size(chosen) < 500) chosen = pick(() => true).filter((b) => b.tag === "p" || /^h\d$/.test(b.tag) || b.tag === "blockquote");
	if (size(chosen) < 500) {
		// Fallback: paragraphs from the plain page text.
		const paras = decodeEntities(plain)
			.split(/\n[ \t\u00a0\r]*\n/)
			.map((x) => tidy(x).replace(/\n/g, " "))
			.filter((x) => x.length >= 60 || (x.length >= 20 && /[.!?:"\u201d]$/.test(x)));
		const fallback = paras.map((text) => ({ tag: "p", text, body: false, article: false, main: false, chrome: false }));
		if (size(fallback) > size(chosen)) chosen = fallback;
	}

	const site = meta["og:site_name"] || host(url);
	const title = (meta["og:title"] || meta["twitter:title"] || tidy(decodeEntities(titleTag)) || titleFromUrl(url)).trim();
	// Drop a leading heading that repeats the title, and stray "Advertisement" lines.
	const isHeading = new Set<string>();
	const lines = chosen
		.map((b) => {
			if (!/^h\d$/.test(b.tag)) return b.text;
			const t = /[.!?:]$/.test(b.text) ? b.text : `${b.text}.`;
			isHeading.add(t);
			return t;
		})
		.filter((t, i) => !(i < 3 && (sameText(t, title) || sameText(t, site))) && !/^(advertisement|ad|sponsored)\.?$/i.test(t));
	// Cut the page tail ("Most popular", "Related tags", sign-up boxes) after the main text.
	const kept = dedupe(lines).filter((t) => !JUNK_LINE.test(t));
	const tail = kept.findIndex((t, i) => i >= kept.length * 0.6 && TAIL_START.test(t));
	const paras = tail > 0 ? kept.slice(0, tail) : kept;
	const text = paras.join("\n\n");
	if (text.length < 200) {
		const count = (f: (b: Block) => boolean) => blocks.filter(f).length;
		const stats = { depth, blocks: blocks.length, p: count((b) => b.tag === "p"), chrome: count((b) => b.chrome), body: count((b) => b.body), article: count((b) => b.article), main: count((b) => b.main), long: count((b) => b.text.length >= 30), tags: [...new Set(blocks.slice(0, 40).map((b) => `${b.tag}${b.chrome ? "*" : ""}:${b.text.length}`))].join(" ") };
		throw new Error(`Podchast extractor: no article text ${JSON.stringify(stats)}`);
	}

	return {
		title,
		byline: cleanByline(meta["author"] || meta["article:author"] || meta["parsely-author"] || meta["sailthru.author"]),
		site,
		excerpt: meta["og:description"] || meta["description"] || meta["twitter:description"] || undefined,
		text,
		lang,
		image: absUrl(meta["og:image"] || meta["twitter:image"], url),
		headings: paras.filter((t) => isHeading.has(t) && t.length <= 200),
	};
}

function absUrl(src: string | undefined, base: string): string | undefined {
	if (!src) return undefined;
	try {
		const u = new URL(src, base);
		return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
	} catch {
		return undefined;
	}
}

const JUNK_LINE = /^(posts from this (author|topic) will be added to your daily email digest|this is the title for the native ad|share this (story|article)|(sign up|subscribe) (to|for) (our|the) newsletter)/i;
const TAIL_START = /^(most popular|most read|related (tags|articles|stories|posts|content|reading)|more from|read (more|next)|recommended( for you)?|you (may|might) also like|subscribe to|sign up for|comments)\.?$|^subscribe to receive|^the verge daily\.?$/i;

// Some sites put profile URLs in the author field. Turn ".../profile/jane-doe" into "Jane Doe".
function cleanByline(s?: string): string | undefined {
	if (!s) return undefined;
	const names = s.split(/\s*,\s*/).map((part) => {
		if (!/^https?:\/\//.test(part)) return part;
		const slug = part.replace(/\/+$/, "").split("/").pop() ?? "";
		return slug.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
	}).filter(Boolean);
	return names.length ? names.join(", ").replace(/, ([^,]+)$/, " and $1") : undefined;
}

const sameText = (a: string, b: string) => a.replace(/\W+/g, "").toLowerCase() === b.replace(/\W+/g, "").toLowerCase();
const dedupe = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);
// HTTP/2 responses have no status text, so use the standard one.
const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 410: "Gone", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");

function tidy(s: string): string {
	return s
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b\u00ad]/g, "")
		.replace(/[ \t\u00a0\r]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const NAMED: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
	lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", laquo: "«", raquo: "»",
	copy: "©", reg: "®", trade: "™", deg: "°", pound: "£", euro: "€", cent: "¢", yen: "¥", times: "×",
	divide: "÷", middot: "·", bull: "•", prime: "′", Prime: "″", frac12: "½", frac14: "¼", frac34: "¾",
	eacute: "é", egrave: "è", aacute: "á", agrave: "à", oacute: "ó", uacute: "ú", iacute: "í", ntilde: "ñ",
	ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", thinsp: " ", ensp: " ", emsp: " ", zwj: "", zwnj: "",
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			try {
				return String.fromCodePoint(code);
			} catch {
				return m;
			}
		}
		return NAMED[e] ?? m;
	});
}

function titleFromUrl(url: string): string {
	const u = new URL(url);
	const slug = u.pathname.split("/").filter(Boolean).pop() ?? u.hostname;
	return decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\.\w+$/, "");
}

/** Split text into chunks of at most `max` chars, at paragraph, then sentence, then word breaks. */
export function chunkText(text: string, max: number): string[] {
	const out: string[] = [];
	let cur = "";
	const push = (piece: string, sep: string) => {
		if (!cur) cur = piece;
		else if (cur.length + sep.length + piece.length <= max) cur += sep + piece;
		else {
			out.push(cur);
			cur = piece;
		}
	};
	for (const para of text.split(/\n{2,}/)) {
		if (para.length <= max) {
			push(para, "\n\n");
			continue;
		}
		for (const sentence of para.match(/[^.!?]+[.!?]+["'\u201d\u2019)]*\s*|[^.!?]+$/g) ?? [para]) {
			const s = sentence.trim();
			if (s.length <= max) {
				push(s, " ");
				continue;
			}
			for (const word of s.split(/\s+/)) push(word.slice(0, max), " ");
		}
	}
	if (cur) out.push(cur);
	return out;
}
