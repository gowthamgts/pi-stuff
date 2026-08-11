# pi-codex-usage

A [pi](https://github.com/earendil-works/pi) extension that shows how much of your Codex subscription (ChatGPT Plus/Pro) quota is left, without hiding anything from pi's default footer.

The custom footer renders pi's standard three lines (working directory + branch + session name, token/cache/cost/context stats with the model right-aligned, and extension statuses). When an `openai-codex` model is selected, the stats line also shows the Codex fast-mode indicator (from the [`codex-fast-mode`](../codex-fast-mode) extension's status) together with the remaining quota:

```text
~/repo (main) • my-session
↑1.2k ↓34 R55.8k W0 CH99.9% $0.010 (sub) 12.5%/128k ⚡ Codex fast · codex 63% left                openai-codex/gpt-test • high
```

The quota segment shows:

- `% left` — the remaining quota in the current weekly window, as reported by OpenAI
- `resets in …` — countdown to the next quota reset, shown when you're at 25% or below

```text
↑1.2k ↓34 $0.010 (sub) 12.5%/128k ⚡ Codex fast · codex 0% left · resets in 48m                openai-codex/gpt-test • high
```

The remaining-percent figure is colored by severity: accent above 25%, warning at 25% and below, error when the quota is exhausted. The quota refreshes every five minutes and shortly after each agent run settles; the reset countdown ticks every minute without refetching. When the quota can't be fetched, the segment shows `codex –`.

Both the fast-mode indicator and the quota only appear when the active model's provider is `openai-codex`; with any other model the footer looks exactly like pi's default.

## Shared status key

The fast-mode indicator is read from the `CODEX_FOOTER_STATUS_KEY` (`codex-custom-footer`) status slot published by the [`codex-fast-mode`](../codex-fast-mode) extension. If that extension isn't installed, the slot is empty and only the quota is shown.

## Data sources

The quota comes from the `wham/usage` endpoint on `chatgpt.com` — the same endpoint Codex CLI uses to detect rate-limit resets. Authentication uses pi's `openai-codex` OAuth token from `~/.pi/agent/auth.json`, falling back to the Codex CLI token from `~/.codex/auth.json`. Access tokens are sent only to OpenAI's endpoint.

OpenAI does not expose the absolute quota size (only the used percentage and the reset time), so the remaining quota is shown as a percentage rather than a token count.

Because pi supports one custom footer at a time, another extension that calls `setFooter()` can replace this footer (and vice versa).

## Install

From npm:

```sh
pi install npm:@gowthamgts/pi-codex-usage
```

From this repository:

```sh
pi install ./extensions/codex-usage
```

Or try it without installing:

```sh
pi -e ./extensions/codex-usage/index.ts
```

## Development

From this extension's directory:

```sh
pnpm test
pnpm run check:load
```
