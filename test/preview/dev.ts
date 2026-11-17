// Status page preview with sample items. Run: cd test/preview && npx wrangler dev --local, open /seed, then /devtoken/.
import worker from "../../src/index";
let now = 0;
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
const mk = (): any[] => [
  { id: "mhxyz001-00000001", url: "https://www.example.com/2026/11/very-long-article-about-the-future-of-spoons", status: "processing", created: iso(4), updated: iso(3), title: "The future of spoons: why cutlery design is entering a golden age of ergonomic innovation", site: "example.com", words: 6200, attempt: 1, run: "r1", chunks: 12 },
  { id: "mhxyz002-00000002", url: "https://substack.com/p/thing", status: "queued", created: iso(20), updated: iso(10), title: "Notes on attention", site: "someone.substack.com", attempt: 2, retryAt: new Date(now + 6 * 60_000).toISOString(), error: "substack.com: Error 429 Too Many Requests" },
  { id: "mhxyz003-00000003", url: "https://www.newyorker.com/magazine/2026/11/16/the-long-read", status: "done", created: iso(200), title: "How a small town learned to love the night sky again", site: "newyorker.com", words: 4810, duration: 1932, chapters: 6, saved: true },
  { id: "mhxyz004-00000004", url: "", status: "done", created: iso(1440), title: "Meeting notes: Q4 planning", text: true, saved: true, words: 820, duration: 311 },
  { id: "mhxyz005-00000005", url: "https://www.theatlantic.com/ideas/archive/2026/11/blocked/", status: "failed", created: iso(3000), attempt: 5, error: "theatlantic.com: Error 403 Forbidden. The site blocks Cloudflare Workers and refuses to serve the article body to any request that comes from a datacenter IP address range." },
  { id: "mhxyz006-00000006", url: "https://example.org/report.pdf", status: "done", created: iso(90 * 1440), title: "Annual report 2026", site: "example.org", words: 15000, gone: true, saved: true, pdf: true, chapters: 14 },
  { id: "mhxyz007-00000007", url: "https://averyveryveryveryveryverylongdomainnamethatgoesonforever.example.com/path/to/an/article/without/a/title?utm_source=x", status: "processing", created: iso(70), updated: iso(65), attempt: 2 },
  { id: "mhxyz008-00000008", url: "https://paulgraham.com/greatwork.html", status: "done", created: iso(5000), title: "How to Do Great Work", site: "paulgraham.com", words: 11900, duration: 4410, chapters: 9, saved: true },
];
export default {
  async fetch(req: Request, env: any, ctx: any) {
    const u = new URL(req.url);
    if (u.pathname === "/seed") {
      now = Date.now(); const items = mk();
      for (const i of items) await env.AUDIO.put(`items/${i.id}`, JSON.stringify(i), { customMetadata: { item: JSON.stringify(i) } });
      for (const i of items) if (i.saved) await env.AUDIO.put(`read/${i.id}.md`, `# ${i.title}\n\nThe first paragraph sets the scene. It has *some emphasis*, a [link](https://example.com) and **bold words**.\n\n## A heading\n\nAnother paragraph, a bit longer, so the reading width shows. The night sky was dark again, and people came out to look.\n\n> A quote from someone wise.\n\n- One point\n- Another point\n`);
      for (let n = 0; n < 5; n++) await env.AUDIO.put(`chunks/mhxyz001-00000001/r1/${n}.json`, "{}");
      return new Response("seeded");
    }
    if (u.pathname === "/clear") {
      const l = await env.AUDIO.list({ prefix: "items/" });
      for (const o of l.objects) await env.AUDIO.delete(o.key);
      return new Response("cleared");
    }
    env.JOBS ??= { send: async () => {}, sendBatch: async () => {} };
    return (worker as any).fetch(req, env, ctx);
  },
  queue() {},
};
