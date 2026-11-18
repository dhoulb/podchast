// Clarifications: text rewrites that run just before Edge TTS speaks a piece of text.
//
// Each rule fixes one thing that Edge reads badly. Add a rule only after a test clip
// shows the problem. Each rule has a test line (`before`) and the text it must become
// (`after`). `npm test` checks them. Clips of each test line, spoken with and without
// the rule, are in test/clarifications/<id>/ (see test/clarifications/README.md).
//
// Rules run in the order of this list. Plain text only: no SSML, because Edge refuses it.

export type Clarification = {
	id: string;
	/** What Edge does wrong, and what the rule does. */
	why: string;
	/** Only for heading text (a paragraph that was a markdown heading). */
	heading?: boolean;
	apply: (text: string) => string;
	/** A test line, and what the rule must turn it into. */
	before: string;
	after: string;
};

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

/** "a", "a or b", "a, b, or c". */
function orList(items: string[]): string {
	if (items.length < 3) return items.join(" or ");
	return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

const WORD = String.raw`\p{L}[\p{L}\p{N}'’-]*`;

export const CLARIFICATIONS: Clarification[] = [
	{
		id: "range-times",
		why: 'Edge reads "1-2x" as "one dash two x". Other ranges, such as "15-30", are already read with "to".',
		apply: (t) => t.replace(/\b(\d+)\s*[-–]\s*(\d+)x\b/g, "$1 to $2 times"),
		before: "I send out letters like these 1-2x a week.",
		after: "I send out letters like these 1 to 2 times a week.",
	},
	{
		id: "footnotes",
		why: 'A footnote number stuck to a full stop ("realize.1") is read as a decimal: "realize point one".',
		apply: (t) => t.replace(/(?<=\p{Ll}[.,;:!?)"”’])\d{1,2}(?=\s|$)/gu, ""),
		before: "It takes hard work to realize.1 Most people never do.",
		after: "It takes hard work to realize. Most people never do.",
	},
	{
		id: "slash-words",
		why: 'Edge reads "/" between words as "slash". It becomes "or", and a series becomes "a, b, or c". URLs stay as they are.',
		apply: (t) =>
			t.replace(new RegExp(String.raw`(?<![\w.:/@-])${WORD}(?:\s?/\s?${WORD})+(?![\w/@]|\.\p{L})`, "gu"), (m) => {
				const parts = m.split(/\s?\/\s?/);
				// Units and short forms (km/h, n/a, w/o) stay as they are.
				if (parts.every((p) => p.length <= 2)) return m;
				if (m.toLowerCase() === "and/or") return "and or";
				return orList(parts);
			}),
		before: "She is a founder/CEO. Pick dog/tiger/bear. Read it on X / Twitter.",
		after: "She is a founder or CEO. Pick dog, tiger, or bear. Read it on X or Twitter.",
	},
	{
		id: "slash-numbers",
		why: 'Edge reads "1/2/3" with "slash". A series of three or more small numbers becomes "1, 2, or 3". Dates, fractions (1/2) and 24/7 stay as they are.',
		apply: (t) =>
			t.replace(/(?<![\w/.])\d{1,2}(?:\/\d{1,2}){2,}(?![\w/])/g, (m) => {
				const n = m.split("/").map(Number);
				// 17/11/26 is a date.
				const date = n.length === 3 && n[0] >= 1 && n[0] <= 31 && n[1] >= 1 && n[1] <= 12 && m.split("/")[2].length === 2;
				return date ? m : orList(n.map(String));
			}),
		before: "Pick 1/2/3 options. Half is 1/2. Open 24/7. Due 17/11/2026.",
		after: "Pick 1, 2, or 3 options. Half is 1/2. Open 24/7. Due 17/11/2026.",
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
		why: 'Edge reads "i.e.", "ie", "e.g." and "eg" as letters. People say "for example".',
		apply: (t) =>
			t.replace(/(?<![\p{L}.])(?:([Ii])\.\s?[Ee]\.|([Ee])\.\s?[Gg]\.|(i)e|(e)g)(?![\p{L}])[.,]?/gu, (_m, a, b, c, d) => {
				const first = (a ?? b ?? c ?? d) as string;
				return first === first.toUpperCase() ? "For example," : "for example,";
			}),
		before: "Black and white thinking. I.e. A toddler hits. Outside work, i.e., outside your field. Pick one, eg running.",
		after: "Black and white thinking. For example, A toddler hits. Outside work, for example, outside your field. Pick one, for example, running.",
	},
	{
		id: "letter-plurals",
		why: 'After a number, "Rs" can be read as "rupees". "the three Rs" becomes "the three R\'s".',
		apply: (t) => t.replace(/\b(\d+|[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our|[Ff]ive|[Ss]ix|[Ss]even|[Ee]ight|[Nn]ine|[Tt]en)\s+(\p{Lu})s\b/gu, "$1 $2's"),
		before: "I call it the three Rs: repost, repurpose and remix. The 6 Ps of copy.",
		after: "I call it the three R's: repost, repurpose and remix. The 6 P's of copy.",
	},
];

/** Run all clarifications on one piece of text that Edge will speak. */
export function clarify(text: string, heading = false): string {
	let t = text;
	for (const c of CLARIFICATIONS) if (!c.heading || heading) t = c.apply(t);
	return t;
}
