# AGENTS.md

Podchast turns article links into a private podcast. Dave shares a link from an iOS Shortcut. A Cloudflare Worker gets the article, reads it aloud, and adds the MP3 to a private RSS feed. Episodes expire after 30 days.

## Workflow: fully automated

This is a fully automated project. Agents may merge their own pull requests without asking Dave.

- Make changes on a branch and open a pull request.
- When CI (the `check` job) is green and there is no merge conflict, merge the pull request.
- A merge to `main` deploys to Cloudflare. Check that the `deploy` job passes after the merge. If it fails, fix it at once.
- Tell Dave what changed after the merge. Do not wait for review.

Still ask Dave before you:

- Delete R2 data (episodes) in bulk, or change retention.
- Rotate or change the `TOKEN` secret. This breaks his Shortcut and feed URLs.
- Change the voice or the TTS engine default.

## Stack

- Cloudflare Workers (Free plan), TypeScript, no runtime dependencies.
- R2 bucket `podchast`: `items/<id>` (item JSON, also in `customMetadata.item`), `audio/<id>.mp3` and `parts/<id>.txt` (text of one part of a long article). Lifecycle rules delete all three prefixes after 31 days.
- Queue `podchast-jobs`: one job per episode. The consumer gets the article, does TTS and writes the MP3. Articles over 40,000 characters (`PART_CHARS`) become several episodes ("Part 1 of 3"), one job each.
- Cron `17 3 * * *`: deletes old items.
- TTS: Microsoft Edge "Read aloud" voices over a WebSocket (`src/edge-tts.ts`, `src/edge-drm.ts`). Workers AI `@cf/deepgram/aura-2-en` is the fallback (`src/tts.ts`).
- Article extraction: HTMLRewriter heuristics (`src/extract.ts`).
- Routes and queue handler: `src/index.ts`. Cover art: `assets/cover.jpg` (1400x1400), bundled as bytes. Bump `?v=` in the feed when it changes, so podcast apps fetch it again.

## URLs

- Worker: `https://podchast.dhoulb.workers.dev`
- Private routes start with `/<TOKEN>/`: status page, `feed.xml`, `add`, `audio/<id>.mp3`, `retry/<id>`.
- `TOKEN` is a Worker secret. Its source is the `TOKEN` GitHub Actions secret; each deploy copies it to Cloudflare. Never write it into the repo, commits, PRs or logs.

## Commands

```sh
npm ci
npm run check            # Type check (CI runs this on every PR)
npm run dev              # Local Worker
cd test && npx wrangler dev --local --port 8799   # Extractor harness
curl -X POST --data-binary @fixture.html http://127.0.0.1:8799/
```

When you change `src/extract.ts`, run the harness on all `test/fixture*.html` files.

## Deploy

`.github/workflows/deploy.yml` runs `wrangler deploy` on every push to `main`, with the repository secret `CLOUDFLARE_API_KEY`. It then copies the `TOKEN` repository secret to the Worker. Optional repository variables `VOICE` and `RATE` override the defaults in `wrangler.jsonc`. Do not deploy by hand.

## Limits to keep in mind

- Free plan: 50 subrequests for each invocation. Edge TTS uses one subrequest for each 3,000-character part.
- A queue consumer has 15 minutes of wall time. Edge parts run 4 at a time.
- Some sites (BBC, The Atlantic) block Cloudflare. That is expected.

## Writing style

Write docs, PR text and messages to Dave in ASD-STE100 style: short sentences, simple words, one instruction for each sentence.
