# Podchast

Podchast turns web articles into a private podcast. Share a link from your iPhone. A Cloudflare Worker gets the article, reads it aloud, and puts the MP3 in a podcast feed. Episodes go away after 30 days.

Everything runs on Cloudflare: Workers, Queues, R2 and (as a fallback) Workers AI.

## How it works

1. An iOS Shortcut sends the link to `POST /add`.
2. The Worker saves an item in R2 and puts a job on the queue.
3. The queue consumer gets the page and finds the article text (HTMLRewriter, no extra libraries).
4. The consumer cuts the text into parts and sends each part to the TTS engine.
5. The consumer joins the MP3 parts and writes one file to R2.
6. `GET /<TOKEN>/feed.xml` shows the finished items as a podcast feed.
7. An R2 lifecycle rule deletes files after 31 days. The feed hides items after 30 days. A daily cron also deletes old files.

## TTS engine

| Engine | Quality | Cost | Risk |
| --- | --- | --- | --- |
| Microsoft Edge "Read aloud" (default) | Very good neural voices | Free | Not an official API. Microsoft can change or block it. |
| Workers AI `@cf/deepgram/aura-2-en` (fallback) | Good | About $0.03 per 1,000 characters (about $0.50 to $1 for a long article) | Official Cloudflare product |

The Worker tries Edge TTS first. If Edge TTS fails three times, it uses Workers AI for the full article. The status page shows which engine made each episode.

"EdgeTTS" is the Edge "Read aloud" service. The Worker talks to it over a WebSocket, the same as the [edge-tts](https://github.com/rany2/edge-tts) Python package. The token code in `src/edge-drm.ts` is a port of edge-tts 7.3.1. If Edge TTS stops working, compare that file with the latest edge-tts `drm.py` and `constants.py`.

To change the voice, set `VOICE` in `wrangler.jsonc`. Some good English voices:

- `en-GB-RyanNeural` (default), `en-GB-SoniaNeural`, `en-GB-LibbyNeural`, `en-GB-ThomasNeural`
- `en-US-AndrewMultilingualNeural`, `en-US-EmmaMultilingualNeural`, `en-US-BrianMultilingualNeural`, `en-US-AvaMultilingualNeural`

Set `RATE` to make speech faster or slower, for example `+10%`. Set `TTS_ENGINE` to `workers-ai` to use only Workers AI.

## URLs

All private URLs contain the secret `TOKEN`. Keep them private.

| URL | Use |
| --- | --- |
| `POST /add` | Add an article. Send the token as `Authorization: Bearer <TOKEN>`. Send the URL as JSON `{"url": "..."}`, as form field `url`, or as plain text. |
| `GET /<TOKEN>` | Status page. Shows all items and has a form to add a URL. |
| `GET /<TOKEN>/feed.xml` | Podcast feed. Add this to your podcast app. |
| `GET /<TOKEN>/audio/<id>.mp3` | Episode audio (supports range requests). |
| `POST /<TOKEN>/retry/<id>` | Try a failed item again. |

## iOS Shortcut

1. Open the **Shortcuts** app. Tap **+** to make a new shortcut. Name it **Podchast**.
2. Tap the **i** (details) button. Turn on **Show in Share Sheet**. Set the input types to **URLs** and **Safari web pages**. Close the details.
3. At the top, set **Receive** to *URLs and Safari web pages* from *Share Sheet*. Set **If there is no input** to **Get Clipboard**.
4. Add the action **Get Contents of URL**:
   - URL: `https://podchast.dave-houlbrooke.workers.dev/add`
   - Method: **POST**
   - Headers: add `Authorization` with value `Bearer <TOKEN>`
   - Request Body: **JSON**. Add a field `url` (Text) with the value **Shortcut Input**.
5. Add the action **Get Dictionary Value**. Get the value for `message` in **Contents of URL**.
6. Add the action **Show Notification** with **Dictionary Value**.
7. In Safari (or any app), tap **Share**, then **Podchast**. You see "Queued: …". The episode is ready in one to three minutes.

## Podcast app

Add `https://podchast.dave-houlbrooke.workers.dev/<TOKEN>/feed.xml` as a feed by URL.

- **Apple Podcasts**: Library, then **…**, then **Follow a Show by URL**.
- **Overcast**: **+**, then **Add URL**.
- **Pocket Casts**: Search, then paste the URL.

## Deploy

GitHub Actions deploys the Worker when a commit lands on `main` (`.github/workflows/deploy.yml`). Pull requests only run the type check. The workflow uses the repository secret `CLOUDFLARE_API_KEY` (a Cloudflare API token that can edit Workers, Queues and R2).

To deploy by hand:

You need Node.js and a Cloudflare account. The Free plan works.

```sh
npm install
npx wrangler login
npx wrangler r2 bucket create podchast
npx wrangler queues create podchast-jobs
npx wrangler secret put TOKEN        # Use a long random value.
npx wrangler deploy
```

Add the R2 lifecycle rules (one time):

```sh
npx wrangler r2 bucket lifecycle add podchast expire-audio audio/ --expire-days 31
npx wrangler r2 bucket lifecycle add podchast expire-items items/ --expire-days 31
```

## Develop

```sh
npm run check     # Type check
npm run dev       # Local Worker (Edge TTS and Workers AI need the network)
```

`test/harness.ts` is a small Worker that shows what the extractor gets from an HTML file:

```sh
cd test && npx wrangler dev --local --port 8799
curl -X POST --data-binary @fixture.html http://127.0.0.1:8799/
```

## Limits

- The extractor is a simple heuristic. Most news sites and blogs work. Pages that need JavaScript or a login do not work.
- On the Workers Free plan, one job can make 50 outbound requests. Each 3,000-character part uses one request, so the limit is about 130,000 characters (about 20,000 words) for each article.
- Retention is set by `RETENTION_DAYS` (default 30) and the R2 lifecycle rules.
