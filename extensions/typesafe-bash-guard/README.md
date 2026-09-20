# pi-typesafe-bash-guard

A [pi](https://github.com/earendil-works/pi) extension that sends every bash command to [TypeSafe AI](https://typesafe.ai) for a safety review before execution.

It reviews both:

- agent `bash` tool calls
- user `!` and `!!` shell commands

## Behavior

TypeSafe's `jev-latest` model classifies each command with a typed Choice:

| Classification | Behavior |
| --- | --- |
| `not_harmful` | Execute normally. |
| `may_be_harmful` | Ask the user to approve execution. Block if declined or no confirmation UI is available. |
| `harmful` | Always block, display a red harmful-command banner, and alert the user. |

A `not_harmful` result below 0.65 confidence is conservatively treated as `may_be_harmful`.

The footer shows `TypeSafe: reviewing…` while an API call is active. Concurrent reviews include the active count. After completion, the footer retains the latest classification or API-error status.

Each review also adds a compact, display-only line adjacent to the bash call before its execution result:

```text
TypeSafe  ✓ not harmful  •  184 ms  •  confidence 96%
```

This line does not enter model context. Expanding it shows the TypeSafe model, raw classification, and probability distribution. Failed reviews show elapsed API time when a request was made, or `API not called` when setup such as 1Password resolution failed first.

## Authentication

Set `TYPESAFE_API_KEY` to either a plaintext TypeSafe API key or a 1Password secret reference.

### Plaintext API key

```sh
export TYPESAFE_API_KEY="your-api-key"
```

### 1Password secret reference

> [!TIP]
> **1Password `op://...` references are supported directly.** You do not need to launch pi through `op run` or place the plaintext key in your shell configuration.

```sh
export TYPESAFE_API_KEY="op://Engineering/TypeSafe/credential"
```

Install and authenticate the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) before starting pi. The reference must point to the field containing the TypeSafe API key. See [1Password secret references](https://developer.1password.com/docs/cli/secret-references/) for reference syntax.

On the first bash review, the extension:

1. Detects the `op://` reference.
2. Runs `op read --no-newline <reference>` directly, without invoking a shell.
3. Keeps the resolved key only in process memory.
4. Passes the key to the official `@typesafe-ai/sdk` client.

The resolved key is reused for the rest of the extension runtime. If resolution fails or is cancelled, a later command retries it.

## Data sent to TypeSafe

Each classification sends the complete command, its working directory, and its source (`agent` or `user`) to TypeSafe. Do not install this extension if those details must not leave your machine.

## Install

From npm:

```sh
pi install npm:@gowthamgts/pi-typesafe-bash-guard
```

From this repository:

```sh
pi install ./extensions/typesafe-bash-guard
```

Or try it without installing:

```sh
pi -e ./extensions/typesafe-bash-guard/index.ts
```

Restart pi or run `/reload` after installation.

## Failure policy

This extension is deliberately **fail-open**: if TypeSafe cannot classify a command because the key is missing, a 1Password lookup fails, the request times out, or the service returns an error, the command is allowed and pi shows a warning when UI is available.

This favors availability over security. A classifier outage therefore weakens the guard. Commands classified as `harmful` are never overridable; `may_be_harmful` commands still require confirmation.

Classification requests have a five-second timeout and do not retry, avoiding long delays before each command.

## Development

From this extension's directory:

```sh
pnpm test
pnpm run check:load
```
