// Checks each clarification against its own test line. Run: npm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLARIFICATIONS, clarify, unmark } from "../src/clarifications.ts";

for (const c of CLARIFICATIONS) {
	test(c.id, () => assert.equal(c.apply(c.before, { lang: c.lang }), c.after));
}

test("ids are unique", () => assert.equal(new Set(CLARIFICATIONS.map((c) => c.id)).size, CLARIFICATIONS.length));

// The text rules, without the pause marks.
const words = (t: string, opts: { heading?: boolean; lang?: string } = {}) => clarify(t, { ...opts, only: (c) => c.id !== "sentence-pause" && c.id !== "paragraph-pause" });

test("heading rules only run on headings", () => {
	assert.equal(words("I – You aren't there."), "I, You aren't there.");
	assert.equal(words("I – You aren't there.", { heading: true }), "Part 1. You aren't there.");
	assert.equal(words("V – Intelligence", { heading: true }), "Part 5. Intelligence");
});

test("text that must not change", () => {
	for (const t of [
		"Set aside 15-30 minutes. It takes 2–3 months.",
		"It is 3.1.3b of the guidelines.",
		"Speed is 50 km/h. N/A. The score was 3-2.",
		"Is it true? It is. This is the one.",
		"He lies. The pie is good. I like eggs.",
		"In 2020–2021 we grew 10%-20%.",
		"It was 3/4 of the cost. Open 24/7.",
		"Sent 10/9/2006 in FY25.", // No country: the order is not known.
		"Mt is short. The MOM test.",
		"Terms apply*. *Note: 5 * 3 is 15.",
	]) {
		assert.equal(words(t), t);
		assert.equal(words(t, { lang: "en" }), t);
	}
});

test("dates", () => {
	assert.equal(words("Sent 10/9/2006.", { lang: "en-US" }), "Sent October 9, 2006.");
	assert.equal(words("Sent 10/9/2006.", { lang: "en-GB" }), "Sent 10 September 2006.");
	assert.equal(words("Sent 10/9/26.", { lang: "en-AU" }), "Sent 10 September 2026.");
	assert.equal(words("Sent 17/11/2026."), "Sent 17 November 2026.");
	assert.equal(words("Sent 11/17/2026."), "Sent November 17, 2026.");
	assert.equal(words("Sent 10.9.2006.", { lang: "en-GB" }), "Sent 10 September 2006.");
	assert.equal(words("Sent 10/9/2006.", { lang: "en-CA" }), "Sent 10/9/2006.");
	assert.equal(words("Sent 32/13/2006.", { lang: "en-GB" }), "Sent 32/13/2006.");
});

test("languages", () => {
	// Other languages get no text rules. The pause marks are for every language.
	assert.equal(words("Pick dog/cat, i.e. one.", { lang: "fr" }), "Pick dog/cat, i.e. one.");
	assert.equal(clarify("Il part. Elle reste.", { lang: "fr-FR" }), "Il part.; Elle reste.");
	assert.equal(words("Up 20% YoY in FY25.", { lang: "en-US" }), "Up 20% year over year in fiscal year 2025.");
});

test("more cases", () => {
	assert.equal(words("he/she"), "he, she");
	assert.equal(words("and/or"), "and or");
	assert.equal(words("Use ie the first word."), "Use that is, the first word.");
	assert.equal(words("— Maxwell Maltz"), "Maxwell Maltz");
	assert.equal(words("right -- of course"), "right, of course");
	assert.equal(words("See www.example.com."), "See example.com.");
	assert.equal(words("See (https://example.com/a)."), "See (example.com/a).");
	assert.equal(words("It costs $3.50 and 5k steps."), "It costs $3.50 and 5k steps.");
});

test("pause marks", () => {
	assert.equal(clarify("One. Two.\n\nThree"), "One.; Two. .. Three");
	assert.equal(clarify("See Mr. Smith. He is in No. 5. Yes."), "See Mr. Smith.; He is in No. 5.; Yes.");
	assert.equal(clarify("The U.S. Army. J. R. R. Tolkien wrote it."), "The U.S. Army.; J. R. R. Tolkien wrote it.");
	assert.equal(unmark('One.; Two. .. Three? . .. She said "yes."; Go'), 'One. Two. Three? She said "yes." Go');
});
