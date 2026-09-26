# pi-codex-fast-mode

A [pi](https://github.com/earendil-works/pi) extension that enables Codex fast mode by default and lets you switch between fast and standard modes.

It adds `service_tier: "priority"` to requests for every model using pi's `openai-codex` provider and `openai-codex-responses` API. This avoids a model-ID allowlist that would need updates whenever OpenAI adds or renames a Codex model. Models that do not support priority processing may ignore the setting or return an error.

## Controls

```text
/fast on
/fast off
/fast status
```

Fast mode defaults to on until you change it. The selected mode is saved globally in `~/.pi/agent/codex-fast-mode.json`, so it applies to new sessions and survives reloads and resumes. Existing session-only preferences are migrated automatically. Supported models show `⚡ Codex fast` or `○ Codex standard` in pi's status bar.

## Shared status key

The indicator is published under the `CODEX_FOOTER_STATUS_KEY` (`codex-custom-footer`) status slot. It appears alongside the separate quota status from [`codex-usage`](../codex-usage) in pi's default footer and in compatible custom footers such as [`git-status`](../git-status).

## Install

From npm:

```sh
pi install npm:@gowthamgts/pi-codex-fast-mode
```

From this repository:

```sh
pi install ./extensions/codex-fast-mode
```

Or try it without installing:

```sh
pi -e ./extensions/codex-fast-mode/index.ts
```

Use the `openai-codex` provider with ChatGPT sign-in to get Codex's credit-based fast mode. Direct API-key usage applies API Priority processing and its separate token pricing instead.

## Cost warning

Fast mode increases supported model speed by about 1.5x and consumes credits at a higher rate. As documented by OpenAI, GPT-5.5, GPT-5.6, and GPT-6 Luna/Astra/Sol use 2.5x Standard credits where available, while GPT-5.4 uses 2x.

See [OpenAI's speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed).

## Development

From this extension's directory:

```sh
pnpm test
pnpm run check:load
```
