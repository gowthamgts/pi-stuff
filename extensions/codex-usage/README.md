# pi-codex-usage

A [pi](https://github.com/earendil-works/pi) extension that shows how much of your Codex subscription (ChatGPT Plus/Pro) quota is left.

When an `openai-codex` model is selected, it publishes the remaining quota in both the five-hour and weekly windows as a compact footer status:

```text
5h - 15%, 7d - 75%
```

When the five-hour quota is at 25% or below, it also shows the time until that window resets:

```text
5h - 0%, 7d - 75% · resets in 48m
```

The status is colored by the most constrained window: accent above 25%, warning at 25% and below, and error when either quota is exhausted. The quota refreshes every five minutes and shortly after each agent run settles; the reset countdown ticks every minute without refetching. When the quota cannot be fetched, the status shows `5h - –, 7d - –`.

The status appears only for the `openai-codex` provider. It uses pi's `setStatus()` API instead of replacing the footer, so pi's standard token, cache, cost, context, and model statistics remain unchanged. It also coexists with custom footers that render extension statuses, including this repository's [`git-status`](../git-status) extension.

When [`codex-fast-mode`](../codex-fast-mode) is installed, its separate `⚡ Codex fast` or `○ Codex standard` status is shown alongside the quota.

## Data sources

The quota comes from the `wham/usage` endpoint on `chatgpt.com`—the same endpoint Codex CLI uses to detect rate-limit resets. Authentication uses pi's `openai-codex` OAuth token from `~/.pi/agent/auth.json`, falling back to the Codex CLI token from `~/.codex/auth.json`. Access tokens are sent only to OpenAI's endpoint.

OpenAI does not expose the absolute quota sizes, only used percentages and reset times, so remaining quota is shown as percentages rather than token counts.

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
