# Podchast

Podchast turns web articles into a private podcast. Share a link from your iPhone. A Cloudflare Worker gets the article, reads it aloud, and puts the MP3 in a private podcast feed. Audio goes away after 90 days. The text (and the original PDF) stays forever, so Podchast is also a permanent read-later list.

Everything runs on Cloudflare: Workers, Queues and R2. The Workers Free plan is enough.

## Set up your own

You need a Cloudflare account, a GitHub account and an iPhone. You set everything in one place: your GitHub repository's **Settings → Secrets and variables → Actions**. Each deploy makes the Cloudflare resources and copies your settings to the Worker.

### 1. Copy the repository

Fork this repository.

### 2. Make two secrets

In your fork, open **Settings → Secrets and variables → Actions**. Add these repository secrets:

- `CLOUDFLARE_API_KEY`: a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens). Use the **Edit Cloudflare Workers** template. Add **Workers R2 Storage: Edit** and **Queues: Edit** if the template does not have them.
- `TOKEN`: the password for your feed. It is also part of every private URL. Make one with `openssl rand -base64 24 | tr '+/' '-_'` and keep a copy in your password manager.

### 3. Deploy

Open the **Actions** tab, then **Deploy**, then **Run workflow**. Later, each push to `main` deploys again.

The deploy makes the R2 bucket `podchast`, the queue `podchast-jobs` and the R2 lifecycle rules, if they are missing. Then it deploys the Worker and copies your secrets to it.

Your Worker is now at `https://podchast.<your-subdomain>.workers.dev`. Open `https://podchast.<your-subdomain>.workers.dev/<TOKEN>` to see the status page.

### 4. Settings

All settings are optional. Add them in the same place, then deploy again.

| Name | Kind | Use |
| --- | --- | --- |
| `CLOUDFLARE_API_KEY` | Secret | Cloudflare API token (required). |
| `TOKEN` | Secret | Feed password (required). |
| `EMAIL_FROM` | Secret | Senders that may email Podchast, comma separated. `@example.com` allows a whole domain. See step 7. |
| `EMAIL_TO` | Variable | The address that Podchast gets email at, for example `devour@podchast.example.com`. The status page shows it. |
| `VOICE` | Variable | Edge voice. Default `en-US-BrianNeural`. See [TTS engine](#tts-engine). |
| `RATE` | Variable | Speech speed, for example `+10%`. Default `+0%`. |
| `PITCH` | Variable | Voice pitch, for example `-5%`. Default `-8%`. |
| `SHORTCUT_URL` | Variable | iCloud link to your own copy of the iOS Shortcut. Default: the shared Podchast Shortcut. |
| `FEED_TITLE` | Variable | Podcast name. Default `🍖 PODCHAST`. |
| `RETENTION_DAYS` | Variable | Days to keep audio. Default `90`. The R2 lifecycle rule follows it. |
| `TTS_ENGINE`, `EDGE_FORMAT`, `AI_MODEL`, `AI_SPEAKER` | Variable | TTS settings. See [TTS engine](#tts-engine). |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Only if your API token can see more than one Cloudflare account. |

The defaults are in `wrangler.jsonc`. A secret that you do not set in GitHub is not changed on the Worker.

### 5. Add the iOS Shortcut

**Quick way:** open your status page on your iPhone. Tap **Copy MOUTH URL** on the 🫦 MOUTH tab, then **Add 🍖 DEVOUR shortcut**. Paste the URL when Shortcuts asks for it. (The button opens [this shared Shortcut](https://www.icloud.com/shortcuts/f463e3946d2b458a937e6a63fa85b45a).)

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

Add `https://podchast.<your-subdomain>.workers.dev/<TOKEN>/noises.xml` as a feed by URL.

- **Apple Podcasts**: Library, then **…**, then **Follow a Show by URL**.
- **Overcast**: **+**, then **Add URL**.
- **Pocket Casts**: Search, then paste the URL.

### 7. Email in (optional)

You can email or forward things to Podchast. A short email with a link adds that link. A longer email becomes an episode, and its subject is the title. Each attached PDF becomes an episode. PDF links work too.

1. In Cloudflare, go to **Email Routing** for your domain. Under **Settings → Subdomains**, add a subdomain such as `podchast.example.com`. This only adds MX records to the subdomain. Mail for the root domain is not changed.
2. Set the GitHub variable `EMAIL_TO` to an address on that subdomain, such as `devour@podchast.example.com`.
3. Set the GitHub secret `EMAIL_FROM` to your own email address. Mail from other senders is rejected. If `EMAIL_FROM` is not set, all mail is rejected.
4. Deploy again. The deploy adds the routing rule `EMAIL_TO` → **Send to a Worker** → `podchast`. For this, the API token also needs **Zone: Read** and **Email Routing Rules: Edit**. Without them, the deploy shows a warning, and you add the rule by hand in **Email Routing → Routing rules**.

## How it works

1. An iOS Shortcut sends the link to `POST /<TOKEN>/add`.
2. The Worker saves an item in R2 and puts a job on the queue.
3. The queue consumer gets the page and finds the article text (HTMLRewriter, no extra libraries).
4. The consumer cuts the text into parts and sends each part to the TTS engine.
5. The consumer joins the MP3 parts and writes one file to R2.
   Article headings become chapters (ID3 `CHAP` frames in the MP3).
   Each episode has a timed transcript (WebVTT, one line for each sentence). The feed links it with `<podcast:transcript>`, so Pocket Casts can show the words as they are spoken.
   Articles longer than 40,000 characters (about 40 minutes) become several episodes: "Part 1 of 3", "Part 2 of 3" and so on. Each part is its own queue job.
6. `GET /<TOKEN>/noises.xml` shows the finished items as a podcast feed.
7. If an article fails three times, the feed gets a short "🤮 SPAT OUT: …" episode. Its notes give the reason.
8. The consumer keeps the article text in `read/<id>.md`, and the original PDF in `read/<id>.pdf`. These files stay forever. `GET /<TOKEN>/read/<id>` shows the text as a page.
9. A daily cron deletes audio after 90 days. An R2 lifecycle rule (91 days) is the backup. The item stays on the status page as "🍖 MEAT", with a **Read** button. **Re-chomp** makes the audio again from the kept text.

## TTS engine

| Engine | Quality | Cost | Risk |
| --- | --- | --- | --- |
| Microsoft Edge "Read aloud" (default) | Very good neural voices | Free | Not an official API. Microsoft can change or block it. |
| Workers AI `@cf/deepgram/aura-2-en` (optional) | Good | About $0.03 per 1,000 characters (about $0.50 to $1 for a long article) | Official Cloudflare product |

The Worker uses only Edge TTS (`TTS_ENGINE` is `edge-only`), so every episode has the same voice. If Edge TTS fails, the job waits and tries again, for about 90 minutes in total. Set `TTS_ENGINE` to `edge` to use Workers AI when Edge TTS fails (a different voice, and the free plan allows about 10 articles a day).

"EdgeTTS" is the Edge "Read aloud" service. The Worker talks to it over a WebSocket, the same as the [edge-tts](https://github.com/rany2/edge-tts) Python package. The token code in `src/edge-drm.ts` is a port of edge-tts 7.3.1. If Edge TTS stops working, compare that file with the latest edge-tts `drm.py` and `constants.py`.

To change the voice, set the GitHub variable `VOICE`, then deploy again. Some good English voices:

- `en-US-BrianNeural` (default), `en-US-ChristopherNeural`, `en-US-GuyNeural`
- `en-NZ-MitchellNeural`, `en-NZ-MollyNeural`
- `en-GB-RyanNeural`, `en-GB-SoniaNeural`, `en-GB-LibbyNeural`, `en-GB-ThomasNeural`
- `en-US-AndrewMultilingualNeural`, `en-US-EmmaMultilingualNeural`, `en-US-BrianMultilingualNeural`, `en-US-AvaMultilingualNeural`

Set these as GitHub variables too. `RATE` makes speech faster or slower, for example `+10%`. `PITCH` makes the voice lower or higher, for example `-5%`. `EDGE_FORMAT` changes the MP3 quality (default `audio-24khz-96kbitrate-mono-mp3`). `TTS_ENGINE` set to `workers-ai` uses only Workers AI.

## URLs

All private URLs contain the secret `TOKEN`. Keep them private.

| URL | Use |
| --- | --- |
| `POST /<TOKEN>/add` | Add an article. Send the URL as JSON `{"url": "..."}`, as form field `url`, or as plain text. Replies in plain text (JSON if you send `Accept: application/json`). |
| `POST /<TOKEN>/add` (text) | Add text instead of a web page. Send JSON `{"content": "...", "title": "..."}`. `title` is optional. `url` is optional and becomes the source link. Markdown is made plain, and `##` headings become chapters. A plain-text body with no link and over 200 characters is also read as text. Limit: 400,000 characters. |
| `POST /add` | The same, with the token in an `Authorization: Bearer <TOKEN>` header. |
| `GET /<TOKEN>` | Status page. Shows all items and has a form to add a URL or paste text. |
| `GET /<TOKEN>/noises.xml` | Podcast feed. Add this to your podcast app. `feed.xml` is the old name and still works. |
| `GET /cover-v5.jpg` | Podcast artwork (`assets/cover.jpg`, 1400x1400). Public, so podcast apps can fetch it. |
| `GET /<TOKEN>/audio/<id>.mp3` | Episode audio (supports range requests). |
| `POST /<TOKEN>/retry/<id>` | Try a failed item again. |
| `POST /<TOKEN>/delete/<id>` | Delete an episode (the status page has a button). |
| `GET /<TOKEN>/manifest.webmanifest` | Web app manifest. Makes the status page a Home Screen app, and an Android share target. |

## Develop

```sh
npm ci
npx wrangler login
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
- Audio retention is set by `RETENTION_DAYS` (default 90) and the R2 lifecycle rule on `audio/`. Items and `read/` files have no lifecycle rule.
