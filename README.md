# PODCHAST

PODCHAST turns web articles into a private podcast. Share a link from your iPhone. A Cloudflare Worker gets the article, reads it aloud, and puts the MP3 in a private podcast feed. Audio goes away after 90 days. The text (and the original PDF) stays forever, so PODCHAST is also a permanent read-later list.

Everything runs on Cloudflare: Workers, Queues and R2. The Workers Free plan is enough.

## Set up your own PODCHAST

You need a Cloudflare account, a GitHub account and a phone. Both accounts are free. Setup takes about 30 minutes. You do not need to write code.

### Easy mode: ask your robot to do it!

Copy this prompt into Claude, ChatGPT or another AI assistant:

```text
Hey robot! I want to set up a PODCHAST that can 🍖 DEVOUR links and content and turn them into a feed of 💥 NOISES for my podcast app. Read this link, do as much as you can yourself, then talk me through the technical steps I need to do: https://github.com/dhoulb/podchast
```

The link goes to the original PODCHAST. On a fork, change it to the link of the fork. (GitHub cannot put the current page link into a README.)

Robot: read [Notes for robots](#notes-for-robots) first.

### Step by step

1. **Make a GitHub account** at [github.com/signup](https://github.com/signup), if you do not have one.
2. **Fork this repository.** At the top of this page, click **Fork**, then **Create fork**. This makes your own copy, at `https://github.com/<your-name>/podchast`.
3. **Turn on Actions in your fork.** Open the **Actions** tab of your fork. Click **I understand my workflows, go ahead and enable them**. GitHub turns Actions off in new forks.
4. **Make a Cloudflare account** at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). The free plan is enough. Then, in the Cloudflare dashboard:
   1. Open **Workers & Pages** (under **Compute**) once. If Cloudflare asks you to choose a `workers.dev` subdomain, choose one. Write it down. Your PODCHAST address is `https://podchast.<your-subdomain>.workers.dev`.
   2. Open **R2 Object Storage** (under **Storage & databases**). Click to turn on R2. Cloudflare can ask for a card. The free tier (10 GB) is much more than PODCHAST uses, so you pay nothing.
5. **Make a Cloudflare API token.** This lets GitHub deploy PODCHAST to your Cloudflare account.
   1. Open [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens). Click **Create Token**.
   2. Next to **Edit Cloudflare Workers**, click **Use template**.
   3. Under **Permissions**, click **+ Add more** and add these rows. If a row is already in the list, skip it.
      - **Account → Workers R2 Storage → Edit**
      - **Account → Queues → Edit**
      - **Zone → Zone → Read** (for a [Custom domain](#custom-domain) or [Email in](#email-in))
      - **Zone → Email Routing Rules → Edit** (only for [Email in](#email-in))
   4. Under **Account Resources**, choose your account. Under **Zone Resources**, choose **All zones** (or the zone of your domain).
   5. Click **Continue to summary**, then **Create Token**. Copy the token. Cloudflare shows it only once.
6. **Make a feed password** (`TOKEN`). It goes in all your private PODCHAST URLs, so keep it secret. Use 24 to 40 random letters and numbers. You can also use `-` and `_`. Do not use other symbols, because the token is part of a URL. To make one in a terminal: `openssl rand -base64 24 | tr '+/' '-_'`. A password manager can also make one.
7. **Add the secrets to GitHub.** In your fork, open **Settings → Secrets and variables → Actions**. On the **Secrets** tab, click **New repository secret** for each one:
   - Name `CLOUDFLARE_API_KEY`, value: the API token from step 5.
   - Name `TOKEN`, value: the feed password from step 6.
8. **Deploy.** Open the **Actions** tab. Click **Deploy** on the left, then **Run workflow**, then the green **Run workflow** button. Wait for a green tick (about 2 minutes). The deploy makes everything in Cloudflare for you. If it fails, open the run and read the red error.
9. **Open your status page** on your phone: `https://podchast.<your-subdomain>.workers.dev/<TOKEN>`. Add it to your Home Screen (in Safari: **Share → Add to Home Screen**).
10. **Add the 🍖 DEVOUR Shortcut** (iPhone). On the 🫦 MOUTH tab, tap **Copy MOUTH URL**, then **Add 🍖 DEVOUR shortcut**. Paste the URL when Shortcuts asks. More help: [iOS Shortcut](#ios-shortcut).
11. **Add the 💥 NOISES feed to your podcast app.** On the 💥 NOISES tab, tap **Copy NOISES URL**. Add it to your podcast app as a feed by URL. More help: [Podcast apps](#podcast-apps).

Now share any article to 🍖 DEVOUR. The episode is ready in a few minutes.

Optional extras: [Email in](#email-in), [Custom domain](#custom-domain), and a different voice ([TTS engine](#tts-engine)).

## Features and docs

- [Settings](#settings)
- [iOS Shortcut](#ios-shortcut)
- [Podcast apps](#podcast-apps)
- [Custom domain](#custom-domain)
- [Cloudflare](#cloudflare)
- [Email in](#email-in)
- [How it works](#how-it-works)
- [TTS engine](#tts-engine)
- [URLs](#urls)
- [Develop](#develop)
- [Limits](#limits)
- [Notes for robots](#notes-for-robots)

### Settings

All settings live in GitHub: **Settings → Secrets and variables → Actions**. Each deploy copies them to the Worker. When you change a setting, deploy again.

`CLOUDFLARE_API_KEY` and `TOKEN` are required (see [Step by step](#step-by-step)). Everything else is optional. The defaults are in `wrangler.jsonc`.

| Name | Kind | Use |
| --- | --- | --- |
| `EMAIL_TO` | Secret | The address that PODCHAST gets email at, for example `devour@podchast.example.com`. The status page shows it. If it is not set, the deploy does not set up email. See [Email in](#email-in). |
| `EMAIL_FROM` | Secret | Senders that may email PODCHAST. Separate them with commas, spaces or new lines, in any mix. `@example.com` allows a whole domain. |
| `VOICE` | Variable | Edge voice. Default `en-US-BrianNeural`. See [TTS engine](#tts-engine). |
| `RATE` | Variable | Speech speed, for example `+10%`. Default `+0%`. |
| `PITCH` | Variable | Voice pitch, for example `-5%`. Default `-8%`. |
| `SHORTCUT_URL` | Variable | iCloud link to your own copy of the iOS Shortcut. Default: the shared PODCHAST Shortcut. |
| `DOMAIN` | Variable | Custom domain, for example `podchast.example.com`. See [Custom domain](#custom-domain). |
| `FEED_TITLE` | Variable | Podcast name. Default `🍖 PODCHAST`. |
| `RETENTION_DAYS` | Variable | Days to keep audio. Default `90`. The R2 lifecycle rule follows it. |
| `TTS_ENGINE`, `EDGE_FORMAT`, `AI_MODEL`, `AI_SPEAKER` | Variable | TTS settings. See [TTS engine](#tts-engine). |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Not needed in most cases: the deploy gets the account from the API token. Set it only if the token can see more than one Cloudflare account. |

A variable that you put on the Secrets tab still works, and it stays out of the deploy log. Use the Secrets tab for anything personal, such as `EMAIL_TO`. Secrets must be on the Secrets tab: the deploy does not read `TOKEN`, `CLOUDFLARE_API_KEY` or `EMAIL_FROM` from variables, because variables show in the deploy log, and the log of a public repository is public. A secret that you do not set in GitHub is not changed on the Worker.

The deploy makes the R2 bucket `podchast`, the queue `podchast-jobs` and the R2 lifecycle rules, if they are missing. Later, each push to `main` deploys again.

### iOS Shortcut

**Quick way:** open your status page on your iPhone. Tap **Copy MOUTH URL** on the 🫦 MOUTH tab, then **Add 🍖 DEVOUR shortcut**. Paste the URL when Shortcuts asks for it. (The button opens [this shared Shortcut](https://www.icloud.com/shortcuts/f463e3946d2b458a937e6a63fa85b45a).)

**Or make it yourself:**

1. Open the **Shortcuts** app. Tap **+** to make a new shortcut. Name it **PODCHAST**.
2. Tap the **i** (details) button. Turn on **Show in Share Sheet**. Close the details.
3. At the top, set **Receive** to *URLs and Safari web pages* from *Share Sheet*. Set **If there is no input** to **Get Clipboard**.
4. Add the action **Get Contents of URL**:
   - URL: `https://podchast.<your-subdomain>.workers.dev/<TOKEN>/add`
   - Tap the arrow to show more. Set Method to **POST**.
   - Request Body: **JSON**. Add a field. Key `url`, type **Text**, value **Shortcut Input**.
   - You do not need headers. The token is in the URL.
5. Add the action **Show Notification**. Set its text to **Contents of URL**.
6. In Safari (or any app), tap **Share**, then **PODCHAST**. You see "Added to PODCHAST: …". The episode is ready in a few minutes.

To share your own Shortcut: in the Shortcut, tap **i**, then **Setup**, and add an **Import Question** for the URL. Then long-press the Shortcut and tap **Share**, then **Copy iCloud Link**. The Import Question removes your token from the shared copy.

**Android:** open the status page in Chrome and tap **Add to Home screen**. PODCHAST then shows in the Android share menu.

**Mac:** Shortcuts sync through iCloud. The PODCHAST Shortcut shows in the **Share** menu in Safari on your Mac too.

### Podcast apps

Add `https://podchast.<your-subdomain>.workers.dev/<TOKEN>/noises.xml` as a feed by URL.

- **Apple Podcasts**: Library, then **…**, then **Follow a Show by URL**.
- **Overcast**: **+**, then **Add URL**.
- **Pocket Casts**: Search, then paste the URL.

### Email in

Optional. You can email or forward things to PODCHAST. A short email with a link adds that link. A longer email becomes an episode, and its subject is the title. Each attached PDF becomes an episode. PDF links work too.

1. In Cloudflare, go to **Email Routing** for your domain. Under **Settings → Subdomains**, add a subdomain such as `podchast.example.com`. This only adds MX records to the subdomain. Mail for the root domain is not changed.
2. Set the GitHub secret `EMAIL_TO` to an address on that subdomain, such as `devour@podchast.example.com`.
3. Set the GitHub secret `EMAIL_FROM` to your own email address (or several, separated by commas, spaces or new lines). Mail from other senders is rejected. If `EMAIL_FROM` is not set, all mail is rejected.
4. Deploy again. The deploy adds the routing rule `EMAIL_TO` → **Send to a Worker** → `podchast`. For this, the API token also needs **Zone: Read** and **Email Routing Rules: Edit**. Without them, the deploy shows a warning, and you add the rule by hand in **Email Routing → Routing rules**.

### How it works

1. An iOS Shortcut sends the link to `POST /<TOKEN>/add`.
2. The Worker saves an item in R2 and puts a job on the queue.
3. The queue consumer gets the page and finds the article text (HTMLRewriter, no extra libraries).
4. The consumer cuts the text into chunks of 3,000 characters and puts one job for each chunk on the queue. Chunk jobs run 4 at a time. Each one speaks its chunk with the TTS engine and saves the MP3 in R2.
5. When the last chunk is done, a join job streams the chunks into one MP3 in R2. The episode is published only then.
   Article headings become chapters (ID3 `CHAP` frames in the MP3).
   Each episode has a timed transcript (WebVTT, one line for each sentence). The feed links it with `<podcast:transcript>`, so Pocket Casts can show the words as they are spoken.
   Every article is one episode, however long it is. Each job does a small amount of work, so it stays under the Free plan CPU limit.
6. `GET /<TOKEN>/noises.xml` shows the finished items as a podcast feed.
7. If an article fails 5 times, the feed gets a short "🤮 SPAT OUT: …" episode. Its notes give the reason.
8. The consumer keeps the article text in `read/<id>.md`, and the original PDF in `read/<id>.pdf`. These files stay forever. The public page `/<id>` shows the text, with a player while the audio lasts. It has no token, so it is safe to 📮 SHARE.
9. A daily cron deletes audio after 90 days. An R2 lifecycle rule (91 days) is the backup. The item stays on the status page as "🍖 MEAT", and its public page still shows the text. **♻️ RECHOMP** makes the audio again from the kept text.

### TTS engine

| Engine | Quality | Cost | Risk |
| --- | --- | --- | --- |
| Microsoft Edge "Read aloud" (default) | Very good neural voices | Free | Not an official API. Microsoft can change or block it. |
| Workers AI `@cf/deepgram/aura-2-en` (optional) | Good | About $0.03 per 1,000 characters (about $0.50 to $1 for a long article) | Official Cloudflare product |

The Worker uses only Edge TTS (`TTS_ENGINE` is `edge-only`), so every episode has the same voice. If Edge TTS fails, the job waits and tries again, up to 5 attempts in about 30 minutes. The status page shows each one as "Attempt 2/5". Set `TTS_ENGINE` to `edge` to use Workers AI when Edge TTS fails (a different voice, and the free plan allows about 10 articles a day).

"EdgeTTS" is the Edge "Read aloud" service. The Worker talks to it over a WebSocket, the same as the [edge-tts](https://github.com/rany2/edge-tts) Python package. The token code in `src/edge-drm.ts` is a port of edge-tts 7.3.1. If Edge TTS stops working, compare that file with the latest edge-tts `drm.py` and `constants.py`.

To change the voice, set the GitHub variable `VOICE`, then deploy again. Some good English voices:

- `en-US-BrianNeural` (default), `en-US-ChristopherNeural`, `en-US-GuyNeural`
- `en-NZ-MitchellNeural`, `en-NZ-MollyNeural`
- `en-GB-RyanNeural`, `en-GB-SoniaNeural`, `en-GB-LibbyNeural`, `en-GB-ThomasNeural`
- `en-US-AndrewMultilingualNeural`, `en-US-EmmaMultilingualNeural`, `en-US-BrianMultilingualNeural`, `en-US-AvaMultilingualNeural`

Set these as GitHub variables too. `RATE` makes speech faster or slower, for example `+10%`. `PITCH` makes the voice lower or higher, for example `-5%`. `EDGE_FORMAT` changes the MP3 quality (default `audio-24khz-96kbitrate-mono-mp3`). `TTS_ENGINE` set to `workers-ai` uses only Workers AI.

### Custom domain

Optional. PODCHAST works on `https://podchast.<your-subdomain>.workers.dev` with no domain. To use your own domain, such as `podchast.example.com`:

1. **Add the domain to Cloudflare.** The domain (for example `example.com`) must be a zone in the same Cloudflare account as PODCHAST. In the dashboard, click **Add a domain** and follow the steps. You change the name servers at the company where you bought the domain. If you do not have a domain, you can buy one in **Domain Registration**.
2. **Choose a host name.** A subdomain such as `podchast.example.com` is best. The host name must have no A, AAAA or CNAME record in **DNS → Records**. MX and TXT records (for [Email in](#email-in)) are fine. Do not add a DNS record yourself.
3. **Check the API token.** It needs **Zone → Zone → Read** and **Zone → Workers Routes → Edit** for this zone. See [Cloudflare](#cloudflare).
4. **Set the GitHub variable** `DOMAIN` to the host name, for example `podchast.example.com`. It goes on the **Variables** tab, not Secrets. Do not add `https://` or a `/`.
5. **Deploy.** Open **Actions → Deploy → Run workflow**.

The deploy attaches the domain to the Worker (**Workers & Pages → podchast → Settings → Domains & Routes**). Cloudflare makes the DNS record and the HTTPS certificate. The first visit can take a few minutes to work.

When `DOMAIN` is set:

- All links (feed, status page, Shortcut URL, share links) use the domain.
- Pages that you open on `workers.dev` go (302) to the same page on the domain.
- The feed, audio and `/add` still work on `workers.dev`. Old feed URLs and old Shortcuts keep working. You do not need to change your podcast app or Shortcut.

You can attach the domain by hand instead: in **Workers & Pages → podchast → Settings → Domains & Routes**, click **Add → Custom domain**. Still set `DOMAIN`, so that links use it.

To stop using the domain, delete the `DOMAIN` variable and deploy. Then remove the domain in **Domains & Routes**.

### Cloudflare

PODCHAST is one Cloudflare Worker named `podchast`. The deploy (`scripts/setup.mjs`, then `wrangler deploy`) makes all of these in your account. You do not make them by hand.

| Part | Name | Use |
| --- | --- | --- |
| Worker | `podchast` | The web pages, the feed, `/add`, the queue consumer, the email handler and the daily cron. |
| R2 bucket | `podchast` | All data: items, kept text and PDFs, MP3s and transcripts. |
| R2 lifecycle rules | `expire-audio`, `expire-parts`, `expire-chunks` | Delete audio after `RETENTION_DAYS` + 1 days, and old work files after 7 or 31 days. Items and text are kept forever. |
| Queue | `podchast-jobs` | One job for each step: get the article, speak each chunk, join the chunks. |
| Cron trigger | `17 3 * * *` | Each day at 03:17 UTC, deletes old audio and marks those items 🍖 MEAT. |
| Workers AI | binding `AI` | Turns PDFs into text. Optional TTS fallback (off by default). |
| Custom domain | your `DOMAIN` | Optional. See [Custom domain](#custom-domain). |
| Email Routing rule | your `EMAIL_TO` → `podchast` | Optional. See [Email in](#email-in). |

**Free plan.** The Workers Free plan is enough for one person. The limits that matter:

- **CPU time:** very little for each invocation. Speech is the heavy part, so PODCHAST cuts each article into chunks of 3,000 characters. Each chunk is its own queue job. The join job streams R2 to R2 and does not touch the bytes.
- **Subrequests:** 50 for each invocation. Each chunk job makes only a few.
- **Requests:** 100,000 a day. One article uses a few dozen.
- **Queues:** 10,000 operations a day. Each job uses about 3, and an article has one job for each chunk, plus two.
- **R2:** 10 GB of storage. An hour of audio is about 43 MB, and audio is deleted after 90 days.
- **Workers AI:** 10,000 neurons a day. Only PDFs use it, unless you turn on the TTS fallback.

If you read a lot, the Workers Paid plan ($5 a month) removes most of these limits. PODCHAST works the same on it.

**API token permissions.** The `CLOUDFLARE_API_KEY` secret is a Cloudflare API token. Make it from the **Edit Cloudflare Workers** template, then add the rows that are missing:

| Permission | Needed for |
| --- | --- |
| Account → Workers Scripts → Edit | Deploy the Worker (in the template). |
| Account → Workers R2 Storage → Edit | Make the bucket and lifecycle rules. |
| Account → Queues → Edit | Make the queue. |
| Account → Account Settings → Read | Find your account (in the template). |
| Zone → Zone → Read | Find the zone of `DOMAIN` or `EMAIL_TO`. |
| Zone → Workers Routes → Edit | Attach `DOMAIN` (in the template). |
| Zone → Email Routing Rules → Edit | Add the `EMAIL_TO` rule. |

If a permission is missing, that deploy step shows a yellow warning, and the rest of the deploy goes on. Only the account, Worker, bucket and queue are required.

**Where to look in the dashboard:**

- **Workers & Pages → podchast:** the Worker, its URL, settings and secrets. **Observability** shows the logs of each request and queue job.
- **R2 Object Storage → podchast:** the files. Do not delete them by hand, unless you want to lose items.
- **Queues → podchast-jobs:** jobs that wait or retry.

### URLs

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
| `GET /<id>` | Public page for one item: player, download link and text. No token. `/<id>.mp3` (`?download`), `/<id>.md` and `/<id>.pdf` are its files. |
| `POST /<TOKEN>/retry/<id>` | Try an item again from attempt 1 (♻️ RECHOMP). |
| `POST /<TOKEN>/delete/<id>` | Delete an episode (the status page has a button). |
| `GET /<TOKEN>/SKILL.md` | Agent skill with your URL and token in it (`?download` saves it). The 👾 ROBOTS section of the 🫦 MOUTH tab has it. Add it to Claude or another AI agent, then ask the agent to add things. |
| `GET /llms.txt` | Notes for AI agents: what PODCHAST is, the API, how it is built and how to change it. No token. `/SKILL.md` is the skill with a `<TOKEN>` placeholder. |
| `GET /<TOKEN>/manifest.webmanifest` | Web app manifest. Makes the status page a Home Screen app, and an Android share target. |

### Develop

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

### Limits

- The extractor is a simple heuristic. Most news sites and blogs work. Pages that need JavaScript or a login do not work.
- On the Workers Free plan, one job can make 50 outbound requests. Each chunk is its own job, so there is no length limit.
- Audio retention is set by `RETENTION_DAYS` (default 90) and the R2 lifecycle rule on `audio/`. Items and `read/` files have no lifecycle rule.

### Notes for robots

You are an AI assistant. A person asked you to set up PODCHAST for them. They may not be technical. Help them like this:

- **Goal:** their own fork of this repository, deployed to their own Cloudflare account by GitHub Actions. They get a private status page, a 🍖 DEVOUR Shortcut and a 💥 NOISES feed in their podcast app. Follow [Step by step](#step-by-step). Do not invent other ways to deploy.
- **Do it yourself if you can.** With a shell and the GitHub CLI (`gh`), you can: fork (`gh repo fork dhoulb/podchast --clone=false`), make the `TOKEN` (`openssl rand -base64 24 | tr '+/' '-_'`), set secrets (`gh secret set TOKEN -R <owner>/podchast`), set variables (`gh variable set DOMAIN -R <owner>/podchast`), start the deploy (`gh workflow run deploy.yml -R <owner>/podchast`) and read its log (`gh run watch`, `gh run view --log-failed`). Turn on Actions in the fork first: the person clicks the button on the **Actions** tab.
- **The person must do these:** make the GitHub and Cloudflare accounts, choose the `workers.dev` subdomain, turn on R2 (it can ask for a card), make the Cloudflare API token, and add the Shortcut and podcast feed on their phone. Give one short step at a time. Say exactly what to click. Wait for them to say "done".
- **Secrets:** `CLOUDFLARE_API_KEY`, `TOKEN`, `EMAIL_FROM` and `EMAIL_TO` go on the **Secrets** tab. All other settings go on the **Variables** tab. See [Settings](#settings). Do not put a secret in a variable: variables show in the public deploy log.
- **Keep the token private.** Do not write the person's `TOKEN` or API token into the repository, a commit, an issue or a public place.
- **The address:** the deploy log (step **Deploy**) prints the Worker URL, `https://podchast.<subdomain>.workers.dev`. The status page is that URL, then `/<TOKEN>`. The feed is `/<TOKEN>/noises.xml`.
- **Test it:** `curl -X POST https://podchast.<subdomain>.workers.dev/<TOKEN>/add -d 'url=https://example.com/some-article'`. The item shows on the status page. Then 🦷 CHEWING, then 💥 NOISE after a few minutes.
- **Common errors:**
  - `The API token can see N accounts`: set the variable `CLOUDFLARE_ACCOUNT_ID` (the ID is in the dashboard URL).
  - An R2 error (code 10042), or "Please enable R2": R2 is not on. Turn it on in the dashboard, then deploy again.
  - "register a workers.dev subdomain": open **Workers & Pages** once and choose one.
  - `Authentication error` (10000): the API token is wrong or misses a permission. See [Cloudflare](#cloudflare).
  - A yellow warning on **Custom domain** or **Email rule**: the token misses a zone permission, or the zone is not in this account.
- **Optional extras,** only if the person wants them: [Email in](#email-in) and [Custom domain](#custom-domain) need their own domain on Cloudflare. A different voice is the `VOICE` variable ([TTS engine](#tts-engine)).
