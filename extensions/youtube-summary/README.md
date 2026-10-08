# YouTube summary

A command-based Pi extension that returns **one short sentence about a YouTube video, followed by its critical takeaways**. It never displays the raw transcript or adds it to your chat history.

## Install

From this checkout:

```sh
pnpm install
pi install ./extensions/youtube-summary
```

Restart Pi or run `/reload` after installation. Local packages require their dependencies to be installed; Pi installs dependencies automatically for npm and git packages.

## Usage

```text
/youtube-summary https://www.youtube.com/watch?v=EBw7gsDPAYQ
/youtube-summary https://youtu.be/EBw7gsDPAYQ
/youtube-summary EBw7gsDPAYQ
```

YouTube Shorts, embed, live, and mobile URLs are also accepted.

Output has this shape:

```text
The video explains how to design reliable software tests.

Critical takeaways
- Test observable behavior rather than implementation details.
- Cover failure paths as well as successful outcomes.
- Keep tests deterministic so regressions are easy to identify.
```

The command aims for 3–7 substantive takeaways and fewer than 300 words, using fewer bullets when the material is thin. It does not trigger an extra chat response after displaying the summary.

## Context and model usage

- Captions are fetched with `youtube-transcript-plus`, the library used by the inspiration skill. English captions (`en`) are requested first, then a regional English track such as `en-US` if available. If no English track exists, the command falls back to the default available captions and summarizes them in English. Network and access errors do not trigger a language fallback.
- The full captions are sent to your **currently selected Pi model in an isolated request**, using your existing Pi authentication. Your chat history, system prompt, tools, and other skills are not included in that request.
- **Only the final summary and video link are added to the conversation.** There is no tool definition or skill prompt added to every chat request.
- This protects the main chat's context budget, but the separate summary call still processes the captions and consumes model tokens/credits. The caption text is sent to the selected model provider.
- Captions are held in memory during the command; the extension does not save them to disk or session entries.

## Limitations

- Videos need accessible manual or auto-generated captions. Private, restricted, captionless, or blocked videos may fail. YouTube changes and rate limits can also break fetching.
- Summaries are caption-based: they cannot describe visuals that are not explained aloud. Auto-generated caption errors can affect accuracy.
- The model is explicitly instructed to write the overview and all takeaways in English, regardless of caption language. A script guard detects non-Latin letters (including Arabic) and requests one English rewrite of the short draft; if that still fails the check, no summary is displayed. This guard is not a full language detector for languages written in Latin characters. The rewrite, when needed, consumes an additional model call but does not add captions or the rejected draft to chat history.
- Requests time out after three minutes. Only one summary runs at a time.
- The caption limit is the smaller of 120,000 characters and the selected model's context window minus a 4,000-token reserve (using a conservative character budget). Longer captions fail explicitly rather than being silently truncated. This is a safety budget, not an exact tokenizer calculation.

## Development

```sh
pnpm --filter @gowthamgts/pi-youtube-summary test
pnpm --filter @gowthamgts/pi-youtube-summary check:load
```

Tests mock YouTube and model calls; they do not require network access or paid model requests.

## Attribution and license

Inspired by [badlogic/pi-skills's youtube-transcript skill](https://github.com/badlogic/pi-skills/tree/main/youtube-transcript). This extension uses the same transcript library, with a separate summarization workflow to keep captions out of the conversation.

MIT. See [LICENSE](./LICENSE).
