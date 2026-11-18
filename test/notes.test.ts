// Show notes: links, section times, and the 2 KB customMetadata limit. Run: npm test
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { id3Tag, readChapters } from "../src/id3.ts";
import { cleanLinks, markdownLinks, notesHtml, notesMeta, parseNotesMeta, stamp } from "../src/notes.ts";

test("markdownLinks finds markdown, angle and bare links, and skips images", () => {
	const md = "See [the *docs*](https://example.com/docs \"Docs\") and <https://a.org/x>.\n![pic](https://img.com/a.png)\nAlso https://b.net/page, then [again](https://example.com/docs).";
	assert.deepEqual(markdownLinks(md), [
		{ url: "https://example.com/docs", text: "the docs" },
		{ url: "https://a.org/x", text: "" },
		{ url: "https://b.net/page", text: "" },
	]);
});

test("cleanLinks drops same-page, anchor and non-web links, and makes links absolute", () => {
	const page = "https://site.com/post";
	const got = cleanLinks(
		[
			{ url: "#top", text: "Top" },
			{ url: "/post#c", text: "Comments" },
			{ url: "mailto:a@b.com", text: "Mail" },
			{ url: "/other", text: "  Other   post " },
			{ url: "https://x.com/a", text: "https://x.com/a" },
		],
		page,
	);
	assert.deepEqual(got, [
		{ url: "https://site.com/other", text: "Other post" },
		{ url: "https://x.com/a", text: "" },
	]);
});

test("notesMeta stays under 2 KB and keeps the full link count", () => {
	const links = Array.from({ length: 80 }, (_, i) => ({ url: `https://example.com/a/long/path/number/${i}?q=${"x".repeat(40)}`, text: `Link number ${i} ✨` }));
	const chapters = Array.from({ length: 6 }, (_, i) => ({ title: `Section ${i}`, start: i * 61.4 }));
	const meta = notesMeta({ links, chapters });
	assert.ok(new TextEncoder().encode(meta).length + "notes".length <= 2048);
	const back = parseNotesMeta(meta);
	assert.equal(back.total, 80);
	assert.equal(back.chapters.length, 6);
	assert.ok(back.links.length > 3 && back.links.length < 80);
	const html = notesHtml(back, "https://p.com/id#links").join("");
	assert.match(html, /1:01 Section 1/);
	assert.match(html, /All 80 links/);
});

test("stamp writes times that podcast apps can tap", () => {
	assert.equal(stamp(0), "0:00");
	assert.equal(stamp(245.7), "4:05");
	assert.equal(stamp(3723), "1:02:03");
});

test("readChapters reads back what id3Tag writes", () => {
	const chapters = [
		{ title: "Start", start: 0 },
		{ title: "Café — part two", start: 61.5 },
		{ title: "End", start: 300 },
	];
	const tag = id3Tag("Title", chapters, 400);
	const mp3 = new Uint8Array(tag.length + 100);
	mp3.set(tag);
	assert.deepEqual(readChapters(mp3), chapters);
});
