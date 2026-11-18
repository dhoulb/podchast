# Clarification clips

One folder for each rule in `src/clarifications.ts`, named by its `id`:

- `before.mp3`: the rule's test line, spoken by Edge without the rule.
- `after.mp3`: the same line with the rule.

Voice: the live default voice, pitch and volume on 18 Nov 2026 (`VOICE`, `PITCH`, `VOLUME`; GitHub variables can override `wrangler.jsonc`).

Make them again with `scripts/clarification-clips.mjs` (see `docs/clarifications.md`). To test a new voice, set `VOICE`, and compare the new `before.mp3` clips with the old ones: a rule may no longer be needed.
