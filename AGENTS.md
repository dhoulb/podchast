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
  - `notes/<id>.json`: show notes. `chapters` (section titles and start times, written by the join job) and `links` (links in the article: from the HTML of a web page, or from the markdown of text and PDFs; `src/notes.ts`). Kept forever. Its `customMetadata.notes` has as much as fits in 2 KB, so the feed gets all notes with one `list()` call. The feed puts the sections (as "4:05 Title", which podcast apps make tappable) and the links in `<content:encoded>`. The public page shows all the links (`#links`).
  - `parts/<id>.txt`: text of one part of an article that older code split into parts. Lifecycle rule: 31 days.
- Email in: the Worker `email()` handler (`src/mail.ts` reads the MIME). Email Routing on the subdomain `podchast.dhoulb.com` sends `devour@` to the Worker. Only senders in the `EMAIL_FROM` secret are accepted. The address is the `EMAIL_TO` GitHub secret (a variable also works). PDFs (attachments and links) become text with Workers AI `toMarkdown`.
- `/add` takes a `url`, or `content` (text or markdown) with an optional `title`. Text is kept in `read/<id>.md` (`item.text` is set).
- Queue `podchast-jobs`, four kinds of job. Prepare (`{id}`): gets the article and plans 3,000-character chunks (`CHUNK_CHARS`). Chunk (`{id, run, chunk}`): speaks one chunk into R2. Join (`{id, run, join}`): queued by the last chunk; streams the chunks into one MP3 with chapters and the VTT. Every article is one episode. Notes (`{id, notes: true}`) makes `notes/<id>.json` again without new audio: links from the kept markdown or the web page, sections from the ID3 chapter tag of the MP3. `{id: "*", notes: true}` queues a notes job for every episode in the feed. `run` names one try, so jobs from an older try do nothing. Chunk jobs do not save the item; the status page counts the chunk files.
- Cron `17 3 * * *`: deletes old audio and marks those items `gone`.
- Clarifications: `src/clarifications.ts` rewrites text that Edge reads badly ("1-2x", "i.e.", slashes, dates, URLs, emoji, Roman numeral headings) just before each Edge request, and adds pause marks (`.; ` after a sentence, `. .. ` after a paragraph). Rules have languages: `item.lang` (from `<html lang>`, `og:locale` or `Content-Language`) goes into the plan and to each chunk job. See `docs/clarifications.md`.
- TTS: Microsoft Edge "Read aloud" voices over a WebSocket (`src/edge-tts.ts`, `src/edge-drm.ts`). Edge refuses SSML `<break>`, so a chunk job speaks each heading in its own request and puts silent MP3 frames around it and at dividers (`segments()` and `silence()` in `src/tts.ts`; markers `HEADING` and `DIVIDER` in the script). The paragraphs between headings go in one request (up to 2,000 characters), and pause marks give the gaps. Edge only by default (`TTS_ENGINE=edge-only`): a failed job retries later, up to 5 attempts (`MAX_ATTEMPTS`, and `max_retries` 4 in `wrangler.jsonc`). Workers AI `@cf/deepgram/aura-2-en` is an optional fallback (`TTS_ENGINE=edge`, `src/tts.ts`).
- Article extraction: HTMLRewriter heuristics (`src/extract.ts`).
- Status page: server-rendered HTML in `statusPage()`. Dark only. Each card has `data-s=<state>`, and the CSS sets the card colour `--c` from it. Its inline script gets the page again every 60 seconds and on pull to refresh, and swaps only the changed cards (`#list li[data-k]`) and the summary chips (`#sum`). Removed cards leave with the `chomp()` animation. Re-chomp and Delete use `fetch()`; the forms still work without JavaScript.
- Routes and queue handler: `src/index.ts`. Chapter tags: `src/id3.ts`. Cover art: `assets/cover.jpg` (1400x1400) and web app icons `assets/icon-*.png`, bundled as bytes. The feed links to the public `/cover-v5.jpg`. Change `COVER` in `src/index.ts` when the art changes, so podcast apps fetch it again.

## URLs

- Worker: `https://podchast.dhoulb.com` (custom domain, GitHub variable `DOMAIN`). `https://podchast.dhoulb.workers.dev` still works.
- With `DOMAIN` set, all links use the domain, and HTML pages opened on another host redirect (302) to it. The feed, audio and `/add` are served on every host. The deploy (`scripts/setup.mjs email`) attaches the domain. The host name shares MX and TXT records with Email Routing; it must have no A, AAAA or CNAME record.
- Private routes start with `/<TOKEN>/`: status page, `noises.xml` (feed; `feed.xml` is an old alias), `add`, `audio/<id>.mp3`, `retry/<id>`, `delete/<id>`, `manifest.webmanifest`, `sw.js`, icons.
- Docs for AI agents (no token): `/llms.txt` (from `src/llms.txt`) and `/SKILL.md` (from `skill/podchast/SKILL.md`, with a `<TOKEN>` placeholder). `{{ORIGIN}}`, `{{REPO}}`, `{{TOKEN}}` and `{{DAYS}}` are filled in by the Worker. `/<TOKEN>/SKILL.md` has the real token (`?download` saves it); the 👾 ROBOTS section of the 🫦 MOUTH tab links it. Never put the token in `/llms.txt` or `/SKILL.md`. When routes or the `/add` API change, update both files.
- Public pages (no token): `/<id>` shows one item with the status page header, a player, a download link and the kept text. Files: `/<id>.mp3` (`?download` saves it), `/<id>.md`, `/<id>.pdf`. No actions. Never put the token on these pages. Each status card links to its page. `/<TOKEN>/read/<id>` redirects there.
- Failed items show in the feed as "🤮 SPAT OUT: …" with one shared clip, `audio/failed-v3.mp3`, made on demand.
- `TOKEN` is a Worker secret. Its source is the `TOKEN` GitHub Actions secret; each deploy copies it to Cloudflare. Never write it into the repo, commits, PRs or logs.

## Keywords

Podchast has its own words. In all UI and copy, write a keyword in ALL CAPS, with its emoji directly before it (for example "Add 🍖 MEAT", "♻️ RECHOMP it"). Card buttons for 📮 SHARE and 🗑️ DELETE show only the emoji.

| Keyword | Meaning |
| --- | --- |
| 🍖 PODCHAST | The app. |
| 🍖 DEVOUR | Add something (the add button, the Shortcut, the bookmarklet). |
| 🫦 MOUTH | The tab and URL where things go in. |
| 🕳️ ABYSS | The list of all items. |
| 💥 NOISES | The audio, and the feed tab. |
| 🍖 MEAT | An item whose audio expired. Only the words are left. |
| 🦷 CHEWING | Making the audio now. |
| 🫦 WAITING | Queued, or waiting for the next attempt. |
| 💥 NOISE | Done. The audio is ready. |
| 🧊 STUCK | No progress for too long. |
| 🤮 YUCK | Failed. In the feed: "🤮 SPAT OUT". |
| 🔗 SOURCE | Open the original page. |
| ♻️ RECHOMP | Make the audio again. |
| 🗑️ DELETE | Delete the item. |
| 📮 SHARE | Share the public page (system share sheet, or copy the link). |
| 🥩 RAW | The raw markdown text (`/<id>.md`). |
| 👾 ROBOTS | The agent skill on the 🫦 MOUTH tab: add things to 🍖 PODCHAST from an AI agent. |

Plain labels stay plain: PDF, Download MP3. "Vom" means content the system cannot eat. Do not use it for adding.

## Docs

Read the doc before you work on its subject.

| File | What it is | Read it when |
| --- | --- | --- |
| `docs/clarifications.md` | The text rewrites before Edge TTS (`src/clarifications.ts`), what Edge reads badly, pause lengths, and the research process: debug clips, Whisper speech to text, comparing transcripts, measuring silences. | Dave reports a word or pause that sounds wrong, you add or change a rule, or you test a new voice or TTS engine. |

## Commands

```sh
npm ci
npm run check            # Type check (CI runs this on every PR)
npm test                 # Clarification rule tests (CI runs this too)
npm run dev              # Local Worker
cd test && npx wrangler dev --local --port 8799   # Extractor harness
curl -X POST --data-binary @fixture.html http://127.0.0.1:8799/
cd test/preview && npx wrangler dev --local --port 8787   # Status page with sample items
curl http://127.0.0.1:8787/seed                             # then open http://127.0.0.1:8787/devtoken/
```

When you change the status page, screenshot it with Playwright at iPhone and desktop widths.

When you change `src/extract.ts`, run the harness on all `test/fixture*.html` files.

When you change `src/clarifications.ts`, follow `docs/clarifications.md`.

## Deploy

`.github/workflows/deploy.yml` deploys on every push to `main`. Do not deploy by hand. All config is in GitHub (**Settings → Secrets and variables → Actions**). The README "Settings" table lists every name.

1. `scripts/setup.mjs` finds the account and makes the R2 bucket, queue and lifecycle rules if they are missing.
2. `wrangler deploy`. A repository variable (or secret) with the name of a `wrangler.jsonc` var overrides it. Variables win.
3. Secrets `TOKEN` and `EMAIL_FROM` are copied to the Worker (only if set in GitHub).
4. `scripts/setup.mjs email` adds the Email Routing rule for `EMAIL_TO`, if the API token can.

Keep personal values (account ID, email addresses) out of the repo. Put them in GitHub variables or secrets.

## Limits to keep in mind

- Free plan: 50 subrequests and very little CPU time for each invocation. Keep the work in each job small: a chunk job speaks one 3,000-character chunk, and the join streams R2 to R2 without touching the bytes.
- A queue consumer has 15 minutes of wall time. Chunk jobs run 4 at a time (`max_concurrency`).
- Some sites (BBC, The Atlantic) block Cloudflare. That is expected.

## Writing style

Write docs, PR text and messages to Dave in ASD-STE100 style: short sentences, simple words, one instruction for each sentence.
