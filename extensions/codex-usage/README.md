# pi-codex-usage

A [pi](https://github.com/earendil-works/pi) extension that shows how much of your Codex subscription (ChatGPT Plus/Pro) quota is left.

When an `openai` model with ChatGPT sign-in or a legacy `openai-codex` model is selected, it publishes the remaining quota in both the five-hour and weekly windows as a compact footer status:

```text
5h - 15%, 7d - 75%
```

When the five-hour quota is at 25% or below, it also shows the time until that window resets:

```text
5h - 0%, 7d - 75% · resets in 48m
```

The status is colored by the most constrained window: accent above 25%, warning at 25% and below, and error when either quota is exhausted. The quota refreshes every five minutes and shortly after each agent run settles; the reset countdown ticks every minute without refetching. When the quota cannot be fetched, the status shows `5h - –, 7d - –`.

The status appears for the `openai` provider when ChatGPT OAuth is active **and** a companion `openai-codex` OAuth login exists for the same account/workspace. Sign in with `/login openai`, then `/login openai-codex` (you can keep using `openai` as your model). The Codex account must contain exactly one registration matching the active OpenAI application's client ID; otherwise quota remains unavailable (`5h - –, 7d - –`). If you already signed in but still see dashes, re-run `/login openai-codex` to replace an invalidated token, then `/reload`. The quota endpoint may also be temporarily unavailable. It also works directly with the legacy `openai-codex` provider. It stays hidden for API-key-only `openai` sessions. It uses pi's `setStatus()` API instead of replacing the footer, so pi's standard token, cache, cost, context, and model statistics remain unchanged. It also coexists with custom footers that render extension statuses, including this repository's [`git-status`](../git-status) extension.

When [`codex-fast-mode`](../codex-fast-mode) is installed, its separate `⚡ Codex fast` or `○ Codex standard` status is shown alongside the quota.

## Data sources

The quota comes from the `wham/usage` endpoint on `chatgpt.com`—the same endpoint Codex CLI uses to detect rate-limit resets. For `openai`, the native Sign in with ChatGPT token cannot access ChatGPT's quota endpoint. The extension reads its application ID locally, then uses the companion `openai-codex` OAuth token from `~/.pi/agent/auth.json` to verify the application's registration at `/wham/usage/chatpass/apps` before requesting plan limits at `/wham/usage`. It does not send the native OpenAI token to these endpoints. Matching the app registration guards against unrelated Codex accounts, though the app ID is not independent cryptographic proof of account identity. For `openai-codex` sessions, it uses that provider's OAuth token and can fall back to the Codex CLI token from `~/.codex/auth.json`. Access tokens are sent only to OpenAI's endpoints.

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
