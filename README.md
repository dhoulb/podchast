# Podchast

Podchast turns web articles into a private podcast. Share a link from your iPhone. A Cloudflare Worker gets the article, reads it aloud, and puts the MP3 in a private podcast feed. Episodes go away after 30 days.

Everything runs on Cloudflare: Workers, Queues, R2 and (as a fallback) Workers AI. The Workers Free plan is enough.

## Set up your own

You need a Cloudflare account, a GitHub account, Node.js 22 and an iPhone.

### 1. Copy the repository

Fork or clone this repository. In `wrangler.jsonc`, change `account_id` to your Cloudflare account ID (Cloudflare dashboard, then **Workers & Pages**, then the right-hand column). Delete the line if you have only one account.

### 2. Make the Cloudflare resources (one time)

```sh
npm ci
npx wrangler login
npx wrangler r2 bucket create podchast
npx wrangler queues create podchast-jobs
npx wrangler r2 bucket lifecycle add podchast expire-audio audio/ --expire-days 31
npx wrangler r2 bucket lifecycle add podchast expire-items items/ --expire-days 31
npx wrangler r2 bucket lifecycle add podchast expire-parts parts/ --expire-days 31
```

### 3. Make a token

The token is the password for your feed. It is also part of every private URL.

```sh
openssl rand -base64 24 | tr '+/' '-_'
```

Keep a copy in your password manager.

### 4. Deploy

**With GitHub Actions (recommended).** A push to `main` deploys the Worker. In your GitHub repository, open **Settings**, then **Secrets and variables**, then **Actions**:

- Secret `CLOUDFLARE_API_KEY`: a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) made from the **Edit Cloudflare Workers** template.
- Secret `TOKEN`: the token from step 3.
- Variable `VOICE` (optional): an Edge voice name, for example `en-GB-SoniaNeural`. The default is `en-NZ-MitchellNeural`.
- Variable `RATE` (optional): speech speed, for example `+10%`.
- Variable `SHORTCUT_URL` (optional): an iCloud link to your own copy of the iOS Shortcut. The default is the shared Podchast Shortcut.

Then push to `main`, or run the **Deploy** workflow by hand from the **Actions** tab.

**By hand.**

```sh
npx wrangler secret put TOKEN     # Paste the token from step 3.
npx wrangler deploy
```

Your Worker is now at `https://podchast.<your-subdomain>.workers.dev`. Open `https://podchast.<your-subdomain>.workers.dev/<TOKEN>` to see the status page.

### 5. Add the iOS Shortcut

**Quick way:** open your status page on your iPhone. Tap **Copy my add URL**, then **Add to share sheet**. Paste the URL when Shortcuts asks for it. (The button opens [this shared Shortcut](https://www.icloud.com/shortcuts/0f622097bb4a45f980ae39ba117be47b).)

**Or make it yourself:**

1. Open the **Shortcuts** app. Tap **+** to make a new shortcut. Name it **Podchast**.
2. Tap the **i** (details) button. Turn on **Show in Share Sheet**. Close the details.
3. At the top, set **Receive** to *URLs and Safari web pages* from *Share Sheet*. Set **If there is no input** to **Get Clipboard**.
4. Add the action **Get Contents of URL**:
   - URL: `https://podchast.<your-subdomain>.workers.dev/<TOKEN>/add`
   - Tap the arrow to show more. Set Method to **POST**.
   - Request Body: **JSON**. Add a field. Key `url`, type **Text**, value **Shortcut Input**.
   - You do not need headers. The token is in the URL.
5. Add the action **Show Notification**. Set its text to **Contents of URL**.
6. In Safari (or any app), tap **Share**, then **Podchast**. You see "Added to Podchast: …". The episode is ready in a few minutes.

To share your own Shortcut: in the Shortcut, tap **i**, then **Setup**, and add an **Import Question** for the URL. Then long-press the Shortcut and tap **Share**, then **Copy iCloud Link**. The Import Question removes your token from the shared copy.

**Android:** open the status page in Chrome and tap **Add to Home screen**. Podchast then shows in the Android share menu.

**Mac:** Shortcuts sync through iCloud. The Podchast Shortcut shows in the **Share** menu in Safari on your Mac too.

### 6. Add the feed to your podcast app

Add `https://podchast.<your-subdomain>.workers.dev/<TOKEN>/feed.xml` as a feed by URL.

- **Apple Podcasts**: Library, then **…**, then **Follow a Show by URL**.
- **Overcast**: **+**, then **Add URL**.
- **Pocket Casts**: Search, then paste the URL.

## How it works

1. An iOS Shortcut sends the link to `POST /<TOKEN>/add`.
2. The Worker saves an item in R2 and puts a job on the queue.
3. The queue consumer gets the page and finds the article text (HTMLRewriter, no extra libraries).
4. The consumer cuts the text into parts and sends each part to the TTS engine.
5. The consumer joins the MP3 parts and writes one file to R2.
   Article headings become chapters (ID3 `CHAP` frames in the MP3).
   Articles longer than 40,000 characters (about 40 minutes) become several episodes: "Part 1 of 3", "Part 2 of 3" and so on. Each part is its own queue job.
6. `GET /<TOKEN>/feed.xml` shows the finished items as a podcast feed.
7. If an article fails three times, the feed gets a short "🤮 SPAT OUT: …" episode. Its notes give the reason.
8. An R2 lifecycle rule deletes files after 31 days. The feed hides items after 30 days. A daily cron also deletes old files.

## TTS engine

| Engine | Quality | Cost | Risk |
| --- | --- | --- | --- |
| Microsoft Edge "Read aloud" (default) | Very good neural voices | Free | Not an official API. Microsoft can change or block it. |
| Workers AI `@cf/deepgram/aura-2-en` (fallback) | Good | About $0.03 per 1,000 characters (about $0.50 to $1 for a long article) | Official Cloudflare product |

The Worker tries Edge TTS first. If Edge TTS fails three times, it uses Workers AI for the full article. The status page shows which engine made each episode.

"EdgeTTS" is the Edge "Read aloud" service. The Worker talks to it over a WebSocket, the same as the [edge-tts](https://github.com/rany2/edge-tts) Python package. The token code in `src/edge-drm.ts` is a port of edge-tts 7.3.1. If Edge TTS stops working, compare that file with the latest edge-tts `drm.py` and `constants.py`.

To change the voice, set the GitHub variable `VOICE` (or `VOICE` in `wrangler.jsonc`), then deploy again. Some good English voices:

- `en-NZ-MitchellNeural` (default), `en-NZ-MollyNeural`
- `en-GB-RyanNeural`, `en-GB-SoniaNeural`, `en-GB-LibbyNeural`, `en-GB-ThomasNeural`
- `en-US-AndrewMultilingualNeural`, `en-US-EmmaMultilingualNeural`, `en-US-BrianMultilingualNeural`, `en-US-AvaMultilingualNeural`

Set `RATE` to make speech faster or slower, for example `+10%`. Set `TTS_ENGINE` to `workers-ai` to use only Workers AI.

## URLs

All private URLs contain the secret `TOKEN`. Keep them private.

| URL | Use |
| --- | --- |
| `POST /<TOKEN>/add` | Add an article. Send the URL as JSON `{"url": "..."}`, as form field `url`, or as plain text. Replies in plain text (JSON if you send `Accept: application/json`). |
| `POST /add` | The same, with the token in an `Authorization: Bearer <TOKEN>` header. |
| `GET /<TOKEN>` | Status page. Shows all items and has a form to add a URL. |
| `GET /<TOKEN>/feed.xml` | Podcast feed. Add this to your podcast app. |
| `GET /<TOKEN>/cover.jpg` | Podcast artwork (`assets/cover.jpg`, 1400x1400). |
| `GET /<TOKEN>/audio/<id>.mp3` | Episode audio (supports range requests). |
| `POST /<TOKEN>/retry/<id>` | Try a failed item again. |
| `POST /<TOKEN>/delete/<id>` | Delete an episode (the status page has a button). |
| `GET /<TOKEN>/manifest.webmanifest` | Web app manifest. Makes the status page a Home Screen app, and an Android share target. |

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
- On the Workers Free plan, one job can make 50 outbound requests. Long articles are split into episodes of about 40,000 characters, so there is no length limit.
- Retention is set by `RETENTION_DAYS` (default 30) and the R2 lifecycle rules.
