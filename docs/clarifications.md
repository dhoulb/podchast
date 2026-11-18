# Clarifications

Clarifications are text rewrites that run just before Edge TTS speaks the text. Each one fixes a thing that Edge reads badly, for example "1-2x" read as "one dash two x".

- Rules: `src/clarifications.ts`. One entry for each rule: `id`, `why`, `apply`, and a test line (`before` and `after`, and `lang` if the rule needs one).
- Where they run: `edgeChunk()` in `src/tts.ts`, on each segment (one Edge request), just before `edgeSynthesise()`. Heading rules (`heading: true`) run only on headings.
- They change only what Edge hears. The kept text (`read/<id>.md`), the status page and chapter titles do not change. The VTT transcript shows the clarified text, because Edge sends back what it spoke. `unmark()` takes the pause marks out of it.
- Tests: `npm test` checks that each rule turns `before` into `after`, and that some normal text does not change.
- Clips: `test/clarifications/<id>/before.mp3` (the test line without the rule) and `after.mp3` (with the rule). Keep them. When a new voice or TTS model comes out, make the clips again and listen, to see which rules are still needed.

## Languages

Each item has a `lang`: the page language, such as `en-GB`. The extractor takes it from `<html lang>`, then `og:locale`, then the `Content-Language` header. A tag with a country wins. Text sent to `/add` and email have no language. The prepare job copies `lang` into the plan, and each chunk job gives it to `clarify()`.

- Each rule has `langs`. The default is `["en"]`: all English. `"en-US"` is only US English. `"*"` is every language (the pause marks and emoji).
- An item with no language is taken to be English, because the voice is English. Rules that need a country (dates, `fiscal-year`) do nothing when there is no country.
- An item in another language (for example `fr`) gets only the `"*"` rules. Note: the English voice still reads it. A voice for each language would be a separate change (ask Dave: it changes the voice default).
- Date order: `en-US` is month first. Other countries (`en-GB`, `en-AU`, `en-IE`, `en-IN`, …) are day first. `en-CA` uses both, so it counts as not known.

## Add a new clarification

Dave sends a problem he heard ("it says dash in 1-2x"). Then:

1. Make a short test line with the problem. Speak it with a debug job and `clarify: false` (see "Tools" below). Transcribe it, and measure it if the problem is a pause.
2. If the problem is real, write one or two rewrites and speak them too. Pick the one that sounds right.
3. Add a rule to `src/clarifications.ts`, with the test line as `before` and the rewrite as `after`. Add text that must not change to `test/clarifications.test.ts`.
4. Run `npm test` and `npm run check`.
5. After the deploy, make the clips: `node --experimental-strip-types scripts/clarification-clips.mjs <id>`. Commit them.
6. Add a row to the table below.

Do not add a rule from a guess. A rule must come from a clip that shows the problem.

## Rules

| id | Edge did this | Rewrite |
| --- | --- | --- |
| `urls` | "https://www.google.com/adventure?utm_source=x" → "https colon slash slash … utm underscore source equal sign x" | "google.com/adventure" ("google.com slash adventure"). A path with more than one part, or a long one, is taken out. |
| `dates` | "10/9/2006" → "October 9th" (US order), also on UK sites | A full date only: "10 September 2006" (day first) or "September 10, 2006" (month first). A part above 12 is the day. If not, the language gives the order. No country: no change. "3/4" never changes. |
| `range-times` | "1-2x a week" → "one dash two x" | "1 to 2 times a week" |
| `money-thousands` | "$5k–10k" → "dollar five K ten K" | "$5,000 to $10,000" |
| `footnotes` | "realize.1 Most" → "realize point one" | Remove the footnote number. |
| `out-of` | "4/5 stars" → "four fifth stars" | "4 out of 5 stars", also after "rated", "scored", "gave it". "1/3 of the cost" is already read "one third of". |
| `slash-words` | "founder/CEO" → "founder slash CEO" | "founder, CEO" (read "founder CEO"). A series: "dog, tiger, bear". Not "or": Dave, 18 Nov 2026. Not for URLs or short forms (km/h, n/a). |
| `slash-numbers` | "1/2/3" → "1 slash 2 slash 3" | "1, 2, 3". Not for dates, fractions (1/2) or 24/7. |
| `underscores` | "subscription_purchased" → "subscription underscore purchased" | "subscription purchased" |
| `emoji` | "▪", "✅", "➡️" → "black small square", "check mark button", "right arrow" | Remove emoji and symbol bullets. |
| `roman-headings` | Heading "I – You…" → the word "I" ("eye"); "V –" → the letter "vee" | "Part 1. You…" (headings only) |
| `quote-attribution` | "subject.– Maxwell Maltz" → "subject dot Maxwell Maltz", no pause | "subject. Maxwell Maltz" |
| `dash-pause` | "right — of course — and" → no pause (90 ms) | "right, of course, and" (comma, about 460 ms). Dave chose a comma over "--" (390 ms). |
| `ie-eg` | "i.e.", "ie", "e.g.", "eg" read as letters | "i.e." → "that is,", "e.g." → "for example," (Dave, 18 Nov 2026) |
| `letter-plurals` | "the three Rs" → maybe "the three rupees" | "the three R's" (after a number only) |
| `masked-words` | "f*ck" → "F asterisk CK", "f*cking" → "F asterisk king" | The masked swear word becomes its first letter: "F", "S". Next to other letters, the letter's name: "effing", "eff ton", "bull ess" (Edge reads "F-ing" as "fing" and "bull-S" as "bulless"). A masked word that is not a swear word is written out ("her*in" → "heroin"). A footnote "*" is not changed. Dave, 18 Nov 2026. |
| `mount` | "Mt. Everest", "Mt Fuji" → "M T Everest" | "Mount Everest" |
| `year-on-year` | "YoY" → "why a why" | "year on year" ("year over year" in en-US). Also QoQ, MoM. |
| `fiscal-year` | "FY25" → "F Y 2025" | "financial year 2025", or "fiscal year 2025" in en-US. No country: no change. |
| `sentence-pause` | A full stop gives 440 ms, which sounds rushed | ".;" after a full stop: about 750 ms. Not after short forms (Dr., Mr., No., U.S., J.). |
| `paragraph-pause` | Paragraphs in one request get 440 ms | ". .." at the end of each paragraph: about 1 s. After "?", "!" or a quote: "? . ..". A colon or a list item with no mark gets a full stop. |

## What Edge already reads well

Tested on 17 and 18 Nov 2026. No rule needed:

- Number ranges, with a hyphen or en dash, with or without spaces: "15-30", "2–3", "1 - 2", "100–200", "£100-£200", "$5-10", "10%-20%", "1990–1995", "2020-21", "9am-5pm", "pages 10-12" are all read with "to". A score "3-2" is read "3 to 2". Dave is fine with that.
- Roman numerals II, III, IV, VI in text and headings are read as numbers. Only "I" and "V" at the start of a heading are a problem.
- ISO dates ("2026-10-31" → "October thirty-first"), "5x5" ("five by five"), "Booking.com" ("booking dot com"), "$10k", "5GB", "10+", "U.S.".
- A plain "•" bullet is silent.
- List items without a full stop still get a normal sentence pause.

## Pauses

Edge refuses SSML `<break>`. There are two ways to make a pause, and Podchast uses both.

1. **Silent MP3 frames between requests** (PR #69). `silence()` in `src/tts.ts` puts silence between two Edge requests. Each heading is its own request, so the silence before and after it, and its chapter time, are exact: 1.5 s plus Edge's own silence before a heading (about 2.5 s in all), and 0.7 s after it (about 0.9 s). A divider (`---`) is 2 s.
2. **Punctuation inside one request.** The paragraphs between two headings go in one request (up to 2,000 characters, `JOIN_CHARS`). The `sentence-pause` and `paragraph-pause` rules add marks that Edge does not read aloud:

   | Boundary | Mark | Silence |
   | --- | --- | --- |
   | Sentence | `.; ` | about 750 ms |
   | Paragraph or list item | `. .. ` | about 1,000 ms |
   | Paragraph that ends with "?", "!" or a quote | `? . .. ` | about 1,050 ms |

   If the paragraphs are longer than 2,000 characters, they go in more than one request, with `EDGE_PAUSE_MS` (500 ms) of silence between them. With Edge's own silence, that is also about 1 s.

Before 18 Nov 2026 (PR #69 to this change), each paragraph was its own request (at most 12 for each chunk), and sentences had 440 ms. Episodes made before need ♻️ RECHOMP to get the new pauses.

Silence measured in "I waited ? then I left." with one mark in the gap (one request):

| Mark | Silence |
| --- | --- |
| em dash "—" | 90 ms |
| en dash "–" | 120 ms |
| " - " | 270 ms |
| "--" | 390 ms |
| full stop | 440 ms |
| new paragraph in the same request | 440 ms |
| comma | 460 ms |
| "…" (one character) | 470 ms |
| colon | 640 ms |
| "..." before a lower case word | 710 ms |
| semicolon | 730 ms |
| ". . ." | 780 ms |
| ". . . . . ." | 1,170 ms |

Before a capital letter (a new sentence), measured on 18 Nov 2026:

| Mark | Silence |
| --- | --- |
| `. ` | 440 ms |
| `... ` | 440 ms (and it sounds like a comma) |
| `?; ` | 590 ms (`?` alone: 550 ms) |
| `. . ` or `. … ` | about 630 ms |
| `.; ` | about 750 ms, steady |
| `. . . ` | 500 to 1,020 ms, not steady |
| `. .. ` | about 1,000 ms, steady |
| `? .. `, `! .. `, `: .. `, no mark + ` .. ` | 550 to 700 ms |
| `? . .. `, `! . .. `, `." . .. ` | 1,050 to 1,140 ms |

Edge does not read any of these marks out loud. A line with only dots gets no audio at all (Edge sends nothing for text with no letters), so the marks always go after the words. An inline `---` is a 520 ms pause; a `---` line in markdown is a divider.

## Tools

The cloud container cannot reach Edge or `podchast.dhoulb.com`. It can reach `podchast.dhoulb.workers.dev`, and it has the Cloudflare API (MCP).

- **Speak a test line.** Send a queue message to `podchast-jobs`: `{id, debug: "edge", text, pause: 0, clarify: false}`. The text is read as markdown, so `## ` makes a heading. `pause: 0` keeps Edge's own spacing. `clarify: false` speaks the text without the rules (the default is with them). The Worker saves `debug/<id>.mp3` and `debug/<id>.json`. Get the MP3 at `/<TOKEN>/debug/<id>.mp3`.
- **Get an episode.** `/<TOKEN>/audio/<id>.mp3`, `/<TOKEN>/audio/<id>.vtt` (what Edge said, one cue for each sentence) and `/<id>.md` (the kept text).
- **Speech to text.** Workers AI `@cf/openai/whisper-large-v3-turbo` through the Cloudflare API: `POST /accounts/<account>/ai/run/@cf/openai/whisper-large-v3-turbo` with `{audio: <base64 MP3>, language: "en", vad_filter: false}`. It returns words with times. It costs about 47 neurons for each minute of audio (the Free plan has 10,000 neurons a day). Limits found:
  - Send at most about 10 minutes (7.2 MB of MP3) in one request. For a longer episode, cut the bytes into parts and add the time offset (96 kbps = 12,000 bytes a second).
  - The R2 API ignores `Range`, so the code gets the whole object and cuts it in memory. A 40 MB episode is too slow for one MCP call, but the call often finishes in the background.
  - To read a result in the container, write it to R2 as `debug/<name>.mp3` and get it from `/<TOKEN>/debug/<name>.mp3`.
- **Compare.** Turn numbers into words on both sides (Whisper writes digits), take out punctuation, and align the word lists (Python `difflib`). Most differences that are left are names, which Whisper often gets wrong. So listen before you blame Edge.
- **Measure pauses.** Decode to 16 kHz mono with ffmpeg, take the level in 10 ms frames, and count frames under -45 dB.

Whisper hides some sounds. It wrote "1-2x" as "1-2 XA", and it left out the "I" of a heading. When a transcript is not clear, compare clip lengths and silences, or ask Dave to listen.

## History

- 17 Nov 2026: first audit. Eight episodes (about 3.5 hours) were transcribed and compared with their text. 98–99% of words matched. 65 test clips. Review page with clips: https://claude.ai/artifact/HgY3Y5j5epFGzDa8KXWrNV
- 18 Nov 2026: Dave chose "or" for slashes, "for example" for i.e., and a comma for dashes. Rules added in `src/clarifications.ts` (PR #70).
- 18 Nov 2026, later: Dave's review. Slashes become commas ("founder/CEO" means both). "i.e." becomes "that is". New rules: `urls`, `dates`, `money-thousands`, `out-of`, `mount`, `year-on-year`, `fiscal-year`, `sentence-pause`, `paragraph-pause`. Rules get languages. Paragraphs in a section go in one request. 28 test lines from NVIDIA NeMo's English text normalization showed that Edge already reads most short forms, units, money, times and kings well (clips in the project files, `clarifications/nemo-2026-11-18/`).

- 18 Nov 2026, evening: `masked-words` (Dave heard "F asterisk CK" in a Dan Koe episode). Dave: do not ♻️ RECHOMP old episodes for a clarification fix. Fix it and move on.

## Ideas not done yet

- NVIDIA NeMo text processing (`nemo_text_processing/text_normalization/en`, Apache 2.0) is a good checklist of cases. Its `data/whitelist/tts.tsv` has about 100 real expansions ("bldg." → "building"). Speak them all through Edge and add rules only for the ones Edge gets wrong.
- Scan the kept text (`read/*.md`) for short forms that appear often, and test those.
- List items get the same 1 s pause as paragraphs. A shorter pause (`.; `) may sound better for short items.
