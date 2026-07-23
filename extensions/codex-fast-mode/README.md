# pi-codex-fast-mode

A [pi](https://github.com/earendil-works/pi) extension that enables Codex fast mode by default and lets you switch between fast and standard modes.

It adds `service_tier: "priority"` to provider requests for these `openai-codex` models:

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`

The extension deliberately leaves unsupported Codex models such as `gpt-5.4-mini` and `gpt-5.3-codex-spark` unchanged.

## Controls

```text
/fast on
/fast off
/fast status
```

Fast mode defaults to on in new sessions. The selected mode is stored in the current pi session and survives reloads and resumes. Supported models show `⚡ Codex fast` or `○ Codex standard` in pi's status bar.

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

Fast mode increases supported model speed by about 1.5x and consumes credits at a higher rate. As documented by OpenAI, GPT-5.5 and GPT-5.6 use 2.5x Standard credits, while GPT-5.4 uses 2x.

See [OpenAI's speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed).

## Development

From this extension's directory:

```sh
pnpm test
pnpm run check:load
```
