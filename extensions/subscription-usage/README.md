# pi-subscription-usage

A [pi](https://github.com/earendil-works/pi) extension that shows how much of your **Claude (Anthropic)** or **Codex (ChatGPT)** subscription quota is left, picking the right one from the model currently selected in the chat.

```text
5h - 69% (r in 1h2m), 7d - 30% (r in 3d5h)
```

The `(r in …)` part is the time until that window resets, shown whenever the reset time is known and fits. On narrow terminals the weekly reset is dropped first, then the 5h one (30 columns are left free for other extension statuses on the same footer line).

| Selected model provider | Quota shown |
| --- | --- |
| `anthropic` (Claude Pro/Max OAuth login) | Claude 5-hour and weekly limits |
| `openai` (ChatGPT sign-in) or `openai-codex` | Codex 5-hour and weekly limits |
| anything else, or API-key-only sessions | hidden |

The status follows `/model` switches and cycling immediately. It is colored by the most constrained window: accent above 25%, warning at 25% and below, error when exhausted, and dim `5h - –, 7d - –` when the quota cannot be fetched. It refreshes every five minutes and shortly after each agent run settles; the countdown ticks every minute without refetching.

It uses pi's `setStatus()` API (key `subscription-usage`) instead of replacing the footer, so it coexists with pi's default footer and with custom footers that render extension statuses.

## Authentication

- **Anthropic:** sign in with `/login anthropic`. The OAuth token from pi is sent only to `api.anthropic.com/api/oauth/usage`. API keys are never used.
- **Codex:** For `openai`, a companion `/login openai-codex` login for the same account is required; for `openai-codex`, pi's token (or the Codex CLI token in `~/.codex/auth.json`) is used. Tokens are sent only to `chatgpt.com`.

Neither vendor exposes absolute quota sizes, so remaining quota is shown as percentages. The Anthropic usage endpoint is undocumented and may change.

## Install

```sh
pi install npm:@gowthamgts/pi-subscription-usage
pi install ./extensions/subscription-usage
pi -e ./extensions/subscription-usage/index.ts
```

## Development

```sh
pnpm test
pnpm run check:load
```
