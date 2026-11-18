// Clarifications: text rewrites that run just before Edge TTS speaks a piece of text.
//
// Each rule fixes one thing that Edge reads badly. Add a rule only after a test clip
// shows the problem. Each rule has a test line (`before`) and the text it must become
// (`after`). `npm test` checks them. Clips of each test line, spoken with and without
// the rule, are in test/clarifications/<id>/ (see test/clarifications/README.md).
//
// Rules run in the order of this list. Plain text only: no SSML, because Edge refuses it.

/** What a rule knows about the text. lang: the article language, such as "en-GB" (undefined if not known). */
export type Context = { lang?: string };

export type Clarification = {
	id: string;
	/** What Edge does wrong, and what the rule does. */
	why: string;
	/** Only for heading text (a paragraph that was a markdown heading). */
	heading?: boolean;
	/** Languages the rule runs on: "en" is all English, "en-US" is only US English, "*" is every language. Default: ["en"]. */
	langs?: string[];
	apply: (text: string, ctx: Context) => string;
	/** A test line, and what the rule must turn it into. lang: the article language for the test. */
	before: string;
	after: string;
	lang?: string;
};

/** "en-GB" → "en". An article with no language is taken to be English, because the voice is English. */
const primary = (lang?: string) => (lang?.split("-")[0] || "en").toLowerCase();
/** "en-GB" → "gb". Undefined if the tag has no country. */
const region = (lang?: string) => lang?.split("-").slice(1).find((p) => /^[a-z]{2}$/i.test(p))?.toLowerCase();
/** Day first or month first, from the country. The US (and Canada, which uses both) is month first or unknown. Undefined if not known. */
function dateOrder(lang?: string): "dmy" | "mdy" | undefined {
	const r = region(lang);
	if (!r || primary(lang) !== "en" || r === "ca") return undefined;
	return r === "us" ? "mdy" : "dmy";
}
const US = (lang?: string) => region(lang) === "us";

/** Does a rule run on text in this language? */
export function runsOn(c: Clarification, lang?: string): boolean {
	const langs = c.langs ?? ["en"];
	const l = (lang || "en").toLowerCase();
	return langs.some((x) => x === "*" || (x.includes("-") ? l === x.toLowerCase() || l.startsWith(`${x.toLowerCase()}-`) : primary(l) === x));
}

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };
function roman(s: string): number | undefined {
	if (!/^(XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(s) || !s) return undefined;
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const v = ROMAN[s[i]];
		n += i + 1 < s.length && ROMAN[s[i + 1]] > v ? -v : v;
	}
	return n;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** 5 → "5,000", 1.5 → "1,500". */
const thousands = (n: string) => Math.round(Number(n) * 1000).toLocaleString("en-US");
/** Masked words: the stem (each letter may be "*" in the text) and what to say. No "say": the first letter, as a capital. */
const MASKED: [string, string?][] = [
	["motherfuck", "mother eff"], ["fuck"], ["shit"], ["bitch"], ["bastard"], ["cunt"], ["cock"], ["dick"], ["prick"], ["twat"], ["wank"], ["piss"], ["damn"], ["crap"], ["hell"], ["arse"], ["ass"],
	["heroin", "heroin"], ["cocaine", "cocaine"], ["porn", "porn"], ["suicide", "suicide"], ["kill", "kill"], ["rape", "rape"], ["sex", "sex"],
];
/** How a letter is said, to write it next to other letters. */
const LETTER: Record<string, string> = { a: "ay", b: "bee", c: "see", d: "dee", f: "eff", h: "aitch", p: "pee", s: "ess", t: "tee", w: "double-u" };
/** Short forms that end with a full stop but do not end a sentence. */
const ABBR = "Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr|Prof|No|vs|etc|Inc|Ltd|Co|Corp|Gen|Gov|Rev|Fig|fig|approx|al|ch|p|pp|vol|Vol|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Ave|Rd|Bros|Capt|Col|Lt|Sgt";

const WORD = String.raw`\p{L}[\p{L}\p{N}'’-]*`;

export const CLARIFICATIONS: Clarification[] = [
	{
		id: "urls",
		why: 'Edge reads a whole URL: "https colon slash slash … question mark utm underscore source equal sign x". The scheme, "www.", the query and long paths are taken out, so it reads "google.com slash adventure".',
		apply: (t) =>
			t.replace(/\b(?:https?:\/\/|www\.)[^\s<>"'()[\]]+/gi, (m) => {
				const end = /[.,;:!?]+$/.exec(m)?.[0] ?? "";
				const url = m.slice(0, m.length - end.length);
				const [host, ...path] = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[?#]/)[0].split("/").filter(Boolean);
				// One short path part is kept ("google.com/adventure"). A longer path is only noise.
				const keep = path.length === 1 && path[0].length <= 24 ? `${host}/${path[0]}` : host;
				return (keep ?? url) + end;
			}),
		before: "Go to https://www.google.com/adventure?utm_source=x or https://example.com/2024/11/18/a-very-long-post-name/.",
		after: "Go to google.com/adventure or example.com.",
	},
	{
		id: "dates",
		why: 'Edge reads a short date the US way: "10/9/2006" is "October 9th". A full date (day, month and year) is written out. If one part is above 12, that part is the day. If not, the article language gives the order (en-US: month first; en-GB and other countries: day first). With no country, the date stays as it is.',
		apply: (t, { lang }) =>
			t.replace(/(?<![\w/.,-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\w/]|[.-]\d)/g, (m, a: string, sep: string, b: string, y: string) => {
				// 1.2.26 and 10-9-26 are more often version numbers or scores. Only "/" may have a 2-digit year.
				if (sep !== "/" && y.length !== 4) return m;
				const x = Number(a);
				const z = Number(b);
				let order: "dmy" | "mdy" | undefined;
				if (x > 12 && z <= 12) order = "dmy";
				else if (z > 12 && x <= 12) order = "mdy";
				else if (x <= 12 && z <= 12) order = dateOrder(lang);
				if (!order) return m;
				const [day, month] = order === "dmy" ? [x, z] : [z, x];
				if (day < 1 || day > 31 || month < 1 || month > 12) return m;
				const year = y.length === 2 ? `${Number(y) <= 50 ? 20 : 19}${y}` : y;
				return order === "dmy" ? `${day} ${MONTHS[month - 1]} ${year}` : `${MONTHS[month - 1]} ${day}, ${year}`;
			}),
		before: "Due 17/11/2026, or 11/17/2026. Sent 10/9/2006. Version 1.2.26.",
		after: "Due 17 November 2026, or November 17, 2026. Sent 10 September 2006. Version 1.2.26.",
		lang: "en-GB",
	},
	{
		id: "range-times",
		why: 'Edge reads "1-2x" as "one dash two x". Other ranges, such as "15-30", are already read with "to".',
		apply: (t) => t.replace(/\b(\d+)\s*[-–]\s*(\d+)x\b/g, "$1 to $2 times"),
		before: "I send out letters like these 1-2x a week.",
		after: "I send out letters like these 1 to 2 times a week.",
	},
	{
		id: "money-thousands",
		why: 'Edge reads "$5k" as "dollar five K", and "$5k–10k" with no "to". "$5,000 to $10,000" is read well.',
		apply: (t) =>
			t
				.replace(/([$£€])\s?(\d+(?:\.\d+)?)[kK]?\s*(?:[-–—]|to)\s*\1?\s?(\d+(?:\.\d+)?)[kK]\b/g, (_m, c: string, a: string, b: string) => `${c}${thousands(a)} to ${c}${thousands(b)}`)
				.replace(/([$£€])\s?(\d+(?:\.\d+)?)[kK]\b/g, (_m, c: string, a: string) => `${c}${thousands(a)}`),
		before: "It costs $5k–10k a year, or £1.5k, or $5-10k.",
		after: "It costs $5,000 to $10,000 a year, or £1,500, or $5,000 to $10,000.",
	},
	{
		id: "footnotes",
		why: 'A footnote number stuck to a full stop ("realize.1") is read as a decimal: "realize point one".',
		apply: (t) => t.replace(/(?<=\p{Ll}[.,;:!?)"”’])\d{1,2}(?=\s|$)/gu, ""),
		before: "It takes hard work to realize.1 Most people never do.",
		after: "It takes hard work to realize. Most people never do.",
	},
	{
		id: "out-of",
		why: 'Edge reads "4/5 stars" as "four fifth stars". A rating becomes "4 out of 5". Fractions ("1/3 of the cost") are already read well.',
		apply: (t) =>
			t
				.replace(/(?<![\w/.])(\d{1,2})\/(\d{1,3})(?=\s+(?:stars?|points?)\b)/g, (m, a: string, b: string) => (Number(a) <= Number(b) ? `${a} out of ${b}` : m))
				.replace(/\b(rated|rates|rating of|scored|scores|score of|gave it|gives it|give it)((?:\s+it)?)\s+(\d{1,2})\/(\d{1,3})(?![\w/])/gi, (m, w: string, it: string, a: string, b: string) => (Number(a) <= Number(b) ? `${w}${it} ${a} out of ${b}` : m)),
		before: "It got 4/5 stars. I rated it 9/10. It was 1/3 of the cost.",
		after: "It got 4 out of 5 stars. I rated it 9 out of 10. It was 1/3 of the cost.",
	},
	{
		id: "slash-words",
		why: 'Edge reads "/" between words as "slash". It becomes a comma: "founder, CEO" (Edge reads it "founder CEO"), and a series becomes "dog, tiger, bear". Not "or": "founder/CEO" means both. URLs and short forms stay as they are.',
		apply: (t) =>
			t.replace(new RegExp(String.raw`(?<![\w.:/@-])${WORD}(?:\s?/\s?${WORD})+(?![\w/@]|\.\p{L})`, "gu"), (m) => {
				const parts = m.split(/\s?\/\s?/);
				// Units and short forms (km/h, n/a, w/o) stay as they are.
				if (parts.every((p) => p.length <= 2)) return m;
				if (m.toLowerCase() === "and/or") return "and or";
				return parts.join(", ");
			})
			// A spaced slash after a quote or bracket, as in X titles: '"5 things" / X'.
			.replace(/(?<=["”’)\]])\s+\/\s+(?=\p{L})/gu, ", "),
		before: 'She is a founder/CEO. Pick dog/tiger/bear. Read it on X / Twitter. Tim on X: "Do 5 things" / X.',
		after: 'She is a founder, CEO. Pick dog, tiger, bear. Read it on X, Twitter. Tim on X: "Do 5 things", X.',
	},
	{
		id: "slash-numbers",
		why: 'Edge reads "1/2/3" with "slash". A series of three or more small numbers becomes "1, 2, 3". Dates, fractions (1/2) and 24/7 stay as they are.',
		apply: (t) =>
			t.replace(/(?<![\w/.])\d{1,2}(?:\/\d{1,2}){2,}(?![\w/])/g, (m) => {
				const n = m.split("/").map(Number);
				// 17/11/26 is a date.
				const date = n.length === 3 && n[0] >= 1 && n[0] <= 31 && n[1] >= 1 && n[1] <= 12 && m.split("/")[2].length === 2;
				return date ? m : n.join(", ");
			}),
		before: "Pick 1/2/3 options. Half is 1/2. Open 24/7. Due 17/11/26.",
		after: "Pick 1, 2, 3 options. Half is 1/2. Open 24/7. Due 17/11/26.",
	},
	{
		id: "underscores",
		why: 'Edge reads "_" in code names as "underscore".',
		apply: (t) => t.replace(/(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, " "),
		before: "Listen for subscription_purchased events.",
		after: "Listen for subscription purchased events.",
	},
	{
		id: "emoji",
		why: 'Edge reads emoji and some symbols by name: "black small square", "check mark button", "right arrow".',
		langs: ["*"],
		apply: (t) =>
			t
				.replace(/[\p{Extended_Pictographic}▪■□☐◦‣→➡►▶✓✔✗✘]️?/gu, " ")
				.replace(/[ \t]{2,}/g, " ")
				.replace(/^ +| +$/gm, "")
				.replace(/ +([,.;:!?])/g, "$1"),
		before: "▪ You act toward that goal ✅ Done.",
		after: "You act toward that goal Done.",
	},
	{
		id: "roman-headings",
		why: 'A Roman numeral at the start of a heading is read badly: "I –" as the word "I", "V –" as the letter "vee". It becomes "Part 1.".',
		heading: true,
		apply: (t) =>
			t.replace(/^([IVXL]{1,6})\s*[–—.:-]\s+/, (m, r: string) => {
				const n = roman(r);
				return n ? `Part ${n}. ` : m;
			}),
		before: "I – You aren't where you want to be.",
		after: "Part 1. You aren't where you want to be.",
	},
	{
		id: "quote-attribution",
		why: 'A dash after a full stop, before a name ("subject.– Maxwell Maltz"), is read as "dot", with no pause.',
		apply: (t) => t.replace(/(?<=[.!?"”’])\s*[–—-]+\s*(?=\p{Lu})/gu, " "),
		before: "It has the same power over the hypnotized subject.– Maxwell Maltz",
		after: "It has the same power over the hypnotized subject. Maxwell Maltz",
	},
	{
		id: "dash-pause",
		why: "An em dash or en dash between words gives no pause (90 ms). A comma gives about 460 ms, which sounds like a spoken dash.",
		apply: (t) =>
			t
				.replace(/^\s*[—–]\s*/gm, "")
				.replace(/(?<=[\p{L}\p{N}%)'"’”])\s*(?:[—–]|--)\s*(?=[\p{L}'"‘“(])/gu, ", "),
		before: "He was right — of course — and we knew it.",
		after: "He was right, of course, and we knew it.",
	},
	{
		id: "ie-eg",
		why: 'Edge reads "i.e.", "ie", "e.g." and "eg" as letters. "i.e." becomes "that is" (its meaning), and "e.g." becomes "for example".',
		apply: (t) =>
			t.replace(/(?<![\p{L}.])(?:([Ii])\.\s?[Ee]\.|([Ee])\.\s?[Gg]\.|(i)e|(e)g)(?![\p{L}])[.,]?/gu, (_m, a, b, c, d) => {
				const first = (a ?? b ?? c ?? d) as string;
				const words = first.toLowerCase() === "i" ? "that is," : "for example,";
				return first === first.toUpperCase() ? words[0].toUpperCase() + words.slice(1) : words;
			}),
		before: "Black and white thinking. I.e. A toddler hits. Outside work, i.e., outside your field. Pick one, eg running.",
		after: "Black and white thinking. That is, A toddler hits. Outside work, that is, outside your field. Pick one, for example, running.",
	},
	{
		id: "letter-plurals",
		why: 'After a number, "Rs" can be read as "rupees". "the three Rs" becomes "the three R\'s".',
		apply: (t) => t.replace(/\b(\d+|[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our|[Ff]ive|[Ss]ix|[Ss]even|[Ee]ight|[Nn]ine|[Tt]en)\s+(\p{Lu})s\b/gu, "$1 $2's"),
		before: "I call it the three Rs: repost, repurpose and remix. The 6 Ps of copy.",
		after: "I call it the three R's: repost, repurpose and remix. The 6 P's of copy.",
	},
	{
		id: "masked-words",
		why: 'Edge reads the "*" in a masked swear word: "f*ck" is "F asterisk CK". The masked part becomes its first letter, so it stays clean: "f*ck" is "F", "f*cking" is "effing", "bullsh*t" is "bull ess". A masked word that is not a swear word ("her*in") is written out.',
		apply: (t) =>
			// Letters on both sides of the "*", so a footnote mark ("terms apply*", "*Note") stays as it is.
			t.replace(/(?<![\p{L}*])\p{L}+\*+[\p{L}*]*\p{L}(?![\p{L}*])/gu, (word) => {
				const lower = word.toLowerCase();
				for (const [stem, say] of MASKED) {
					const m = new RegExp(`^(\\p{L}*?)(${stem.replace(/[a-z]/g, (c) => `[${c}*]`)})(\\p{L}*)$`, "u").exec(lower);
					if (!m || !m[2].includes("*")) continue;
					const [, pre, , post] = m;
					const head = word.slice(0, pre.length);
					const tail = word.slice(word.length - post.length);
					if (say) return head + (head || word[0] === word[0].toLowerCase() ? say : say[0].toUpperCase() + say.slice(1)) + tail;
					// A swear word becomes one letter. Next to other letters, the letter's name is written,
					// because Edge reads "F-ing" as "fing" and "bull-S" as "bulless".
					if (!head && !tail) return stem[0].toUpperCase();
					const name = LETTER[stem[0]] ?? stem[0].toUpperCase();
					// "sh*tty" → "essy", "b*tches" → "bees".
					const rest = tail.replace(new RegExp(`^${stem.at(-1)}(?=y$)`, "i"), "").replace(/^es$/i, "s");
					const end = !rest ? "" : /^(?:ing|in|ed|er|ers|s|y)$/i.test(rest) ? rest : ` ${rest}`;
					const said = (head ? `${head} ` : "") + name + end.toLowerCase();
					return word[0] === word[0].toUpperCase() ? said[0].toUpperCase() + said.slice(1) : said;
				}
				// Not known: keep the letters before the first "*" as one capital letter.
				return word[0].toUpperCase();
			})
			// "a F" and "a eff ton" are said "an F", "an eff ton".
			.replace(/\b([Aa]) (?=[AEFHILMNORSX]\b|[Ee]ff|[Ee]ss|[Aa]itch)/g, "$1n "),
		before: "Making a f*ckton of money. What the f*ck. Some bullsh*t. Not doing sh*t. Six months on her*in. Nothing would f*cking change. A b*tch.",
		after: "Making an eff ton of money. What the F. Some bull ess. Not doing S. Six months on heroin. Nothing would effing change. A B.",
	},
	{
		id: "mount",
		why: 'Edge reads "Mt." and "Mt" before a name as the letters "M T".',
		apply: (t) => t.replace(/\bMt\.?(?=\s+\p{Lu})/gu, "Mount"),
		before: "He lives near Mt. Everest Road, by Mt Fuji.",
		after: "He lives near Mount Everest Road, by Mount Fuji.",
	},
	{
		id: "year-on-year",
		why: 'Edge reads "YoY" as "why a why". It becomes "year on year" ("year over year" in US English). Also QoQ and MoM.',
		apply: (t, { lang }) =>
			t.replace(/\b(YoY|YOY|QoQ|QOQ|MoM)\b/g, (m) => {
				const unit = { y: "year", q: "quarter", m: "month" }[m[0].toLowerCase() as "y" | "q" | "m"];
				return `${unit} ${US(lang) ? "over" : "on"} ${unit}`;
			}),
		before: "Revenue is up 20% YoY and 5% QoQ.",
		after: "Revenue is up 20% year on year and 5% quarter on quarter.",
	},
	{
		id: "fiscal-year",
		why: 'Edge reads "FY25" as "F Y 2025". It becomes "financial year 2025" (UK and others) or "fiscal year 2025" (US). With no country, it stays as it is.',
		apply: (t, { lang }) => {
			const r = region(lang);
			if (!r || primary(lang) !== "en") return t;
			return t.replace(/\bFY\s?'?(\d{2}|\d{4})\b/g, (_m, y: string) => `${r === "us" ? "fiscal" : "financial"} year ${y.length === 2 ? `20${y}` : y}`);
		},
		before: "Sales grew in FY25 and FY 2026.",
		after: "Sales grew in financial year 2025 and financial year 2026.",
		lang: "en-GB",
	},
	{
		id: "sentence-pause",
		why: 'A full stop gives only 440 ms, which sounds rushed. ".;" gives about 750 ms, and Edge does not read the ";". Not after short forms such as "Dr." or "U.S.".',
		langs: ["*"],
		apply: (t) => t.replace(new RegExp(String.raw`(?<!\b(?:${ABBR}))(?<=[\p{Ll}%)]{2}|\p{N}|[\p{Ll}\p{N}%)]["”’])\.(["”’]?)(?=[ \t]+["“‘(]?\p{Lu})`, "gu"), ".$1;"),
		before: 'They set goals. But it is hard. She said "it works." Then Dr. Smith left the U.S. Army.',
		after: 'They set goals.; But it is hard.; She said "it works."; Then Dr. Smith left the U.S. Army.',
	},
	{
		id: "paragraph-pause",
		why: 'Paragraphs in one Edge request get only 440 ms between them. ". .." at the end of each paragraph gives about 1 second. Edge does not read the dots.',
		langs: ["*"],
		apply: (t) =>
			t.replace(/([.!?:;,]?)(["”’)]?)[ \t]*\n{2,}\s*/g, (_m, p: string, q: string) => {
				// Measured: ". .." after a full stop is about 1 s. After "?", "!" or a quote, a lone "." first is needed: "? . ..".
				if (p === "." && !q) return ". .. ";
				if (p === "." || p === "?" || p === "!") return `${p}${q} . .. `;
				// A colon, comma or no mark (a list item) becomes a full stop.
				return `${q}. .. `;
			}),
		before: "That is harder.\n\nIs it?\n\nShe said \"yes.\"\n\nThere are steps:\n\nWrite every day\n\nRead",
		after: 'That is harder. .. Is it? . .. She said "yes." . .. There are steps. .. Write every day. .. Read',
	},
];

/** Run the clarifications on one piece of text that Edge will speak. heading: the text is a heading. lang: the article language. */
export function clarify(text: string, opts: { heading?: boolean; lang?: string; only?: (c: Clarification) => boolean } = {}): string {
	let t = text;
	for (const c of CLARIFICATIONS) {
		if (c.heading && !opts.heading) continue;
		if (!runsOn(c, opts.lang) || (opts.only && !opts.only(c))) continue;
		t = c.apply(t, { lang: opts.lang });
	}
	return t;
}

/** The text without the pause marks, for the transcript. */
export const unmark = (s: string) =>
	s
		.replace(/([.!?]["”’]?);/g, "$1")
		.replace(/(^|\s)\.(?: ?\.)+(?=\s|$)/g, "")
		.trim();
