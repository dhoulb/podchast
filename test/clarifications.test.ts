// Checks each clarification against its own test line. Run: npm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLARIFICATIONS, clarify } from "../src/clarifications.ts";

for (const c of CLARIFICATIONS) {
	test(c.id, () => assert.equal(c.apply(c.before), c.after));
}

test("ids are unique", () => assert.equal(new Set(CLARIFICATIONS.map((c) => c.id)).size, CLARIFICATIONS.length));

test("heading rules only run on headings", () => {
	assert.equal(clarify("I – You aren't there."), "I, You aren't there.");
	assert.equal(clarify("I – You aren't there.", true), "Part 1. You aren't there.");
	assert.equal(clarify("V – Intelligence", true), "Part 5. Intelligence");
});

test("text that must not change", () => {
	for (const t of [
		"Set aside 15-30 minutes. It takes 2–3 months.",
		"See https://example.com/a/b for more.",
		"It is 3.1.3b of the guidelines.",
		"Speed is 50 km/h. N/A. The score was 3-2.",
		"Is it true? It is. This is the one.",
		"He lies. The pie is good. I like eggs.",
		"In 2020–2021 we grew 10%-20%.",
		"Dates like 17/11/26 stay.",
	]) {
		assert.equal(clarify(t), t);
	}
});

test("more cases", () => {
	assert.equal(clarify("he/she"), "he or she");
	assert.equal(clarify("and/or"), "and or");
	assert.equal(clarify("Use ie the first word."), "Use for example, the first word.");
	assert.equal(clarify("— Maxwell Maltz"), "Maxwell Maltz");
	assert.equal(clarify("right -- of course"), "right, of course");
});
