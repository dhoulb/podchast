// Makes the Cloudflare resources that Podchast needs.
// The deploy workflow runs `node scripts/setup.mjs` before `wrangler deploy` (account, bucket, queue, lifecycle),
// and `node scripts/setup.mjs email` after it (Email Routing rule, which needs the Worker to exist).
// Each step is safe to run again: it only adds what is missing.
// Needs CLOUDFLARE_API_TOKEN. Optional: CLOUDFLARE_ACCOUNT_ID, RETENTION_DAYS, EMAIL_TO.
// Writes CLOUDFLARE_ACCOUNT_ID to $GITHUB_ENV, so the next steps (wrangler) use the same account.

import { appendFileSync } from "node:fs";

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = "podchast";
const QUEUE = "podchast-jobs";
const WORKER = "podchast";
const DAY = 86400;

if (!TOKEN) fail("CLOUDFLARE_API_TOKEN is not set. Add the CLOUDFLARE_API_KEY repository secret.");

async function cf(method, path, body) {
	const res = await fetch(API + path, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || json.success === false) {
		const msg = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || res.statusText;
		const err = new Error(`${method} ${path}: ${res.status} ${msg}`);
		err.status = res.status;
		throw err;
	}
	return json;
}

function fail(msg) {
	console.log(`::error::${msg}`);
	process.exit(1);
}

function warn(msg) {
	console.log(`::warning::${msg}`);
}

// Runs one step. A failed step gives a warning, not a failed deploy, because the resource can already exist
// and the API token can lack the permission to check it.
async function step(name, fn) {
	try {
		console.log(`${name}: ${await fn()}`);
	} catch (e) {
		warn(`${name}: ${e.message}`);
	}
}

// 1. Account.
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
	const { result } = await cf("GET", "/accounts?per_page=50");
	if (result.length !== 1) fail(`The API token can see ${result.length} accounts. Set the repository variable CLOUDFLARE_ACCOUNT_ID.`);
	account = result[0].id;
}
console.log(`Account: ${account}`);
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_ACCOUNT_ID=${account}\n`);
const acc = `/accounts/${account}`;

const email = process.argv[2] === "email";

// 2. R2 bucket.
if (!email) await step(`R2 bucket ${BUCKET}`, async () => {
	try {
		await cf("GET", `${acc}/r2/buckets/${BUCKET}`);
		return "exists";
	} catch (e) {
		if (e.status !== 404) throw e;
	}
	await cf("POST", `${acc}/r2/buckets`, { name: BUCKET });
	return "made";
});

// 3. Queue.
if (!email) await step(`Queue ${QUEUE}`, async () => {
	const { result } = await cf("GET", `${acc}/queues?per_page=100`);
	if (result.some((q) => q.queue_name === QUEUE)) return "exists";
	await cf("POST", `${acc}/queues`, { queue_name: QUEUE });
	return "made";
});

// 4. R2 lifecycle rules. Audio goes one day after the cron deletes it. Parts go after 31 days.
if (!email) await step("R2 lifecycle rules", async () => {
	const days = Number(process.env.RETENTION_DAYS || 90);
	if (!(days > 0)) throw new Error(`RETENTION_DAYS is not a number: ${process.env.RETENTION_DAYS}`);
	const want = [
		["expire-audio", "audio/", days + 1],
		["expire-parts", "parts/", 31],
	].map(([id, prefix, d]) => ({
		id,
		enabled: true,
		conditions: { prefix },
		deleteObjectsTransition: { condition: { type: "Age", maxAge: d * DAY } },
	}));
	const { result } = await cf("GET", `${acc}/r2/buckets/${BUCKET}/lifecycle`);
	const rules = result?.rules ?? [];
	const same = want.every((w) => JSON.stringify(rules.find((r) => r.id === w.id)?.deleteObjectsTransition) === JSON.stringify(w.deleteObjectsTransition) && rules.find((r) => r.id === w.id)?.conditions?.prefix === w.conditions.prefix);
	if (same) return "up to date";
	const ids = new Set(want.map((w) => w.id));
	await cf("PUT", `${acc}/r2/buckets/${BUCKET}/lifecycle`, { rules: [...rules.filter((r) => !ids.has(r.id)), ...want] });
	return `set (audio ${days + 1} days, parts 31 days)`;
});

// 5. Email Routing rule: EMAIL_TO → this Worker. Email Routing must already be on for the domain or subdomain.
// The API token needs "Zone: Read" and "Email Routing Rules: Edit". Without them, this step only warns.
const to = (process.env.EMAIL_TO ?? "").trim().toLowerCase();
if (email && !to) console.log("Email rule: skipped (EMAIL_TO is not set)");
if (email && to) {
	await step(`Email rule ${to}`, async () => {
		const parts = to.split("@")[1]?.split(".") ?? [];
		let zone;
		for (let i = 0; i < parts.length - 1 && !zone; i++) {
			const { result } = await cf("GET", `/zones?name=${parts.slice(i).join(".")}&account.id=${account}`);
			zone = result[0];
		}
		if (!zone) throw new Error(`No zone for ${to} in this account (or the token cannot read zones).`);
		const { result } = await cf("GET", `/zones/${zone.id}/email/routing/rules?per_page=50`);
		const hit = result.find((r) => r.matchers?.some((m) => m.field === "to" && m.value?.toLowerCase() === to));
		if (hit) {
			const ok = hit.actions?.some((a) => a.type === "worker" && a.value?.includes(WORKER));
			if (!ok) throw new Error(`A rule for ${to} exists but does not send to the ${WORKER} Worker. Change it in the dashboard.`);
			return "exists";
		}
		await cf("POST", `/zones/${zone.id}/email/routing/rules`, {
			name: "Podchast",
			enabled: true,
			matchers: [{ type: "literal", field: "to", value: to }],
			actions: [{ type: "worker", value: [WORKER] }],
		});
		return "made";
	});
}
