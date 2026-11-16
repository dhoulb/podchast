# AGENTS.md

Podchast turns article links into a private podcast. Dave shares a link from an iOS Shortcut. A Cloudflare Worker gets the article, reads it aloud, and adds the MP3 to a private RSS feed. Audio expires after 90 days. The text stays forever, as a read-later archive.

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
- R2 bucket `podchast`:
  - `items/<id>`: item JSON, also in `customMetadata.item`. Kept forever.
  - `read/<id>.md` (article text) and `read/<id>.pdf` (original PDF). Kept forever. Shown at `/<TOKEN>/read/<id>`.
  - `audio/<id>.vtt`: timed transcript (one cue for each sentence, from Edge TTS sentence boundaries). The feed links it with `<podcast:transcript>`, so Pocket Casts shows it live. It is deleted with the MP3.
  - `audio/<id>.mp3`: deleted after `RETENTION_DAYS` (90) by the cron. Lifecycle rule: 91 days. The item then gets `gone: true` and shows as "🍖 MEAT". Re-chomp reads `read/<id>.md` and makes the audio again.
  - `chunks/<id>/<run>/`: `plan.json` (text of each chunk), and `<n>.mp3` with `<n>.json` (length, sentence times) for each chunk. The join job deletes them. Lifecycle rule: 7 days.
  - `parts/<id>.txt`: text of one part of an article that older code split into parts. Lifecycle rule: 31 days.
- Email in: the Worker `email()` handler (`src/mail.ts` reads the MIME). Email Routing on the subdomain `podchast.dhoulb.com` sends `devour@` to the Worker. Only senders in the `EMAIL_FROM` secret are accepted. The address is the `EMAIL_TO` GitHub variable. PDFs (attachments and links) become text with Workers AI `toMarkdown`.
- `/add` takes a `url`, or `content` (text or markdown) with an optional `title`. Text is kept in `read/<id>.md` (`item.text` is set).
- Queue `podchast-jobs`, three kinds of job. Prepare (`{id}`): gets the article and plans 3,000-character chunks (`CHUNK_CHARS`). Chunk (`{id, run, chunk}`): speaks one chunk into R2. Join (`{id, run, join}`): queued by the last chunk; streams the chunks into one MP3 with chapters and the VTT. Every article is one episode. `run` names one try, so jobs from an older try do nothing. Chunk jobs do not save the item; the status page counts the chunk files.
- Cron `17 3 * * *`: deletes old audio and marks those items `gone`.
- TTS: Microsoft Edge "Read aloud" voices over a WebSocket (`src/edge-tts.ts`, `src/edge-drm.ts`). Edge only by default (`TTS_ENGINE=edge-only`): a failed job retries later, up to 5 attempts (`MAX_ATTEMPTS`, and `max_retries` 4 in `wrangler.jsonc`). Workers AI `@cf/deepgram/aura-2-en` is an optional fallback (`TTS_ENGINE=edge`, `src/tts.ts`).
- Article extraction: HTMLRewriter heuristics (`src/extract.ts`).
- Routes and queue handler: `src/index.ts`. Chapter tags: `src/id3.ts`. Cover art: `assets/cover.jpg` (1400x1400) and web app icons `assets/icon-*.png`, bundled as bytes. The feed links to the public `/cover-v5.jpg`. Change `COVER` in `src/index.ts` when the art changes, so podcast apps fetch it again.

## URLs

- Worker: `https://podchast.dhoulb.workers.dev`
- Private routes start with `/<TOKEN>/`: status page, `noises.xml` (feed; `feed.xml` is an old alias), `add`, `audio/<id>.mp3`, `retry/<id>`, `delete/<id>`, `manifest.webmanifest`, `sw.js`, icons.
- Failed items show in the feed as "🤮 SPAT OUT: …" with one shared clip, `audio/failed-v3.mp3`, made on demand.
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

`.github/workflows/deploy.yml` deploys on every push to `main`. Do not deploy by hand. All config is in GitHub (**Settings → Secrets and variables → Actions**). The README "Settings" table lists every name.

1. `scripts/setup.mjs` finds the account and makes the R2 bucket, queue and lifecycle rules if they are missing.
2. `wrangler deploy`. A repository variable with the name of a `wrangler.jsonc` var overrides it.
3. Secrets `TOKEN` and `EMAIL_FROM` are copied to the Worker (only if set in GitHub).
4. `scripts/setup.mjs email` adds the Email Routing rule for `EMAIL_TO`, if the API token can.

Keep personal values (account ID, email addresses) out of the repo. Put them in GitHub variables or secrets.

## Limits to keep in mind

- Free plan: 50 subrequests and very little CPU time for each invocation. Keep the work in each job small: a chunk job speaks one 3,000-character chunk, and the join streams R2 to R2 without touching the bytes.
- A queue consumer has 15 minutes of wall time. Chunk jobs run 4 at a time (`max_concurrency`).
- Some sites (BBC, The Atlantic) block Cloudflare. That is expected.

## Writing style

Write docs, PR text and messages to Dave in ASD-STE100 style: short sentences, simple words, one instruction for each sentence.
