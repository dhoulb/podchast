---
name: podchast
description: Send text, notes, a summary or an article URL to my PODCHAST feed, so it becomes a podcast episode. Use when I ask to add, send, read out or "podchast" something, or to put it in my podcast.
---

# PODCHAST

PODCHAST turns text or an article URL into an episode in my private podcast feed. Audio expires after {{DAYS}} days. The text is kept forever.

## Endpoint

`POST {{ORIGIN}}/{{TOKEN}}/add`

The token in the path is the password. Do not put it in public places (GitHub issues, pull requests, public docs, shared chats).

## Send a URL

```bash
curl -sS -X POST "{{ORIGIN}}/{{TOKEN}}/add" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/article"}'
```

PODCHAST gets the page and finds the article text itself. PDF links work too.

## Send text

```bash
curl -sS -X POST "{{ORIGIN}}/{{TOKEN}}/add" \
  -H 'Content-Type: application/json' \
  --data @- <<'JSON'
{"title": "Episode title", "content": "# Heading\n\nText to read aloud..."}
JSON
```

- `content`: plain text or Markdown. Headings become chapters. Limit: 400,000 characters.
- `title`: optional, but set one. It is the episode name in the podcast app.
- `url`: optional with `content`. It becomes the source link.
- Build the JSON with a tool (for example `jq -n --arg t "$TITLE" --arg c "$CONTENT" '{title:$t,content:$c}'`) so quotes and new lines are escaped.
- No shell? Any HTTP tool that can send a JSON POST works.

## Writing for the ear

- Write full sentences. Spell out symbols. Do not use tables, code blocks or bare URLs, because the voice reads them literally.
- Use headings to split long pieces into chapters.
- Very long text is fine. It becomes one episode, with chapters from the headings.

## After sending

The reply is plain text. On success it starts with "OM NOM NOM! SWALLOWED". If the URL is already in PODCHAST, the reply says so, and nothing new is added. A 401 reply means the token is wrong.

Making the audio takes 1 to 5 minutes. Tell me the episode title and that it will be in the feed soon.

Status page: `{{ORIGIN}}/{{TOKEN}}`
