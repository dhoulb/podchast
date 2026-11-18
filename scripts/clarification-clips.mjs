// Speak the test line of each clarification with Edge, without and with the rule,
// and save the clips in test/clarifications/<id>/before.mp3 and after.mp3.
//
// Run after the rules are deployed (the "after" clip uses the live Worker):
//   CLOUDFLARE_API_TOKEN=... PODCHAST_TOKEN=... node --experimental-strip-types scripts/clarification-clips.mjs [id ...]
//
// Optional: CLOUDFLARE_ACCOUNT_ID, ORIGIN (default https://podchast.dhoulb.com), VOICE (test another voice).
// Each clip is a queue debug job: {id, debug: "edge", text, pause: 0, clarify, lang}. The Worker saves debug/<id>.mp3,
// served at /<TOKEN>/debug/<id>.mp3.
import { mkdirSync, writeFileSync } from "node:fs";
import { CLARIFICATIONS } from "../src/clarifications.ts";

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const FEED = process.env.PODCHAST_TOKEN;
const ORIGIN = process.env.ORIGIN ?? "https://podchast.dhoulb.com";
if (!TOKEN || !FEED) throw new Error("Set CLOUDFLARE_API_TOKEN and PODCHAST_TOKEN.");

async function cf(method, path, body) {
	const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
	const json = await res.json();
	if (!json.success) throw new Error(`${method} ${path}: ${JSON.stringify(json.errors)}`);
	return json.result;
}

let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) account = (await cf("GET", "/accounts?per_page=50"))[0].id;
const queue = (await cf("GET", `/accounts/${account}/queues?per_page=100`)).find((q) => q.queue_name === "podchast-jobs");
if (!queue) throw new Error("Queue podchast-jobs not found.");

const only = process.argv.slice(2);
const rules = CLARIFICATIONS.filter((c) => !only.length || only.includes(c.id));
const stamp = Date.now().toString(36);
const jobs = rules.flatMap((c) => {
	// Debug text is read as markdown, so a heading rule gets a heading.
	const text = c.heading ? `## ${c.before}` : c.before;
	return [
		{ rule: c.id, side: "before", body: { id: `cl-${stamp}-${c.id}-b`.slice(0, 40), debug: "edge", text, pause: 0, clarify: false, lang: c.lang, voice: process.env.VOICE } },
		{ rule: c.id, side: "after", body: { id: `cl-${stamp}-${c.id}-a`.slice(0, 40), debug: "edge", text, pause: 0, clarify: true, lang: c.lang, voice: process.env.VOICE } },
	];
});
await cf("POST", `/accounts/${account}/queues/${queue.queue_id}/messages/batch`, { messages: jobs.map((j) => ({ body: j.body })) });
console.log(`Queued ${jobs.length} clips. Waiting for the Worker...`);

for (const j of jobs) {
	const url = `${ORIGIN}/${FEED}/debug/${j.body.id}.mp3`;
	for (let i = 0; ; i++) {
		const res = await fetch(url);
		if (res.ok) {
			mkdirSync(`test/clarifications/${j.rule}`, { recursive: true });
			writeFileSync(`test/clarifications/${j.rule}/${j.side}.mp3`, new Uint8Array(await res.arrayBuffer()));
			console.log(`test/clarifications/${j.rule}/${j.side}.mp3`);
			break;
		}
		if (i > 60) throw new Error(`No clip after 5 minutes: ${j.body.id}`);
		await new Promise((r) => setTimeout(r, 5000));
	}
}
