# pi-typesafe-bash-guard

A [pi](https://github.com/earendil-works/pi) extension that sends every bash command to [TypeSafe AI](https://typesafe.ai) for a safety review before execution, unless explicitly disabled for the current session.

It reviews both:

- agent `bash` tool calls
- user `!` and `!!` shell commands

## Session toggle

The guard is **on by default** in every new session. Control it with:

| Command | Behavior |
| --- | --- |
| `/typeguard off` | Disable safety reviews for this session. |
| `/typeguard on` | Re-enable safety reviews for this session. |
| `/typeguard status` or `/typeguard` | Show the current setting without changing it. |

While off, **both agent bash calls and user `!`/`!!` commands bypass all guard classifications, LLM risk reviews, approval prompts, and harmful-command blocks**. No review requests or review entries are generated for those commands. The footer displays `⚠ TypeSafe guard: OFF (this session)` until you re-enable it. Reviews already in progress still finish normally.

The choice is stored only in the current session's history, not in the global settings file. It survives `/reload` and resuming the same session. It follows the active branch: navigating to a point before the toggle restores the setting at that point, and forks inherit the setting from their selected history. Unrelated new sessions always start enabled.

## Behavior

When enabled, TypeSafe's `jev-latest` model classifies each command with a typed Choice:

| Classification | Behavior |
| --- | --- |
| `not_harmful` | Execute normally. |
| `may_be_harmful` | Ask the user to approve execution. Block if declined or no confirmation UI is available. |
| `harmful` | Always block, display a red harmful-command banner, and alert the user. |

A `not_harmful` result below 0.65 confidence is conservatively treated as `may_be_harmful`.

The footer shows `TypeSafe: reviewing…` while a TypeSafe API call is active. When a review is escalated, it switches to `Bash guard: deferred to LLM openai/gpt-6-luna…`. After successful escalation, it retains an explicit attribution, for example:

```text
Bash guard: ✓ not harmful • handled by LLM openai/gpt-6-luna (deferred from TypeSafe)
```

Concurrent reviews include the active count and distinguish TypeSafe reviews from deferred LLM reviews; completing another command does not hide an ongoing LLM review. Failed escalations show the LLM model, failure, and retained approval requirement. Reviews without escalation retain the latest TypeSafe classification or API-error status.

Each review also adds a compact, display-only line adjacent to the bash call before its execution result:

```text
TypeSafe  ✓ not harmful  •  184 ms  •  confidence 96%
```

This line does not enter model context. Expanding it shows the TypeSafe model, raw classification, and probability distribution. Failed reviews show elapsed API time when a request was made, or `API not called` when setup such as 1Password resolution failed first.

## Optional LLM risk review

Instead of interrupting you for every `may_be_harmful` command, the guard can ask a second model (for example `gpt-6-luna` through your Codex subscription) for a risk analysis first. It only asks you when that model also thinks a human should decide.

On the first session start after installation, the extension creates `~/.pi/agent/typesafe-bash-guard.json` if it does not already exist:

```json
{
  "bell": true,
  "fallbackModel": null,
  "fallbackScope": "risky",
  "fallbackTimeoutMs": 30000
}
```

Existing files are never overwritten. Creation happens when a session starts, not during `pi install`; if the file cannot be created, pi shows a warning and the guard continues with default settings.

To enable or change the judging model, edit `fallbackModel` in that file and restart pi or run `/reload`. For example:

```json
{
  "fallbackModel": "openai-codex/gpt-6-luna",
  "fallbackScope": "risky",
  "fallbackTimeoutMs": 30000,
  "bell": true
}
```

`fallbackModel` is an exact `provider/model-id` from pi's model registry, with an ID shown by `/model` or `pi --list-models`. Use `openai/gpt-6-luna` for the OpenAI provider, or `openai-codex/gpt-6-luna` for the Codex provider; each uses its own configured provider authentication. `codex/gpt-6-luna` only works if you have separately registered a provider named `codex`. The model must be available in your installed pi catalog or custom provider configuration. The guard reuses pi's provider authentication (including `/login`) without changing the session's active model. This feature requires a pi version exposing `ctx.modelRegistry.complete`; older versions retain human confirmation.

The fallback is **disabled by default**. An omitted, `null`, empty, non-string, or malformed `fallbackModel` disables escalation without affecting other valid settings or attempting an LLM request. Only a non-empty string in `provider/model-id` format enables it; a correctly formatted but unavailable model retains the original approval requirement.

`fallbackScope` chooses which results are escalated, for both agent and user bash commands:

| `fallbackScope` | Escalated to the LLM |
| --- | --- |
| `"risky"` (default) | Every result that would otherwise ask you: any `may_be_harmful`, plus `not_harmful` below 0.65 confidence. |
| `"uncertain"` | Only results below 0.65 confidence (or the programmatically configured `minimumConfidence`). Confident `may_be_harmful` results still ask you directly. |

When configured:

- TypeSafe `harmful` results are always blocked, even at low confidence. They are never sent to the LLM for an override.
- An LLM `not_harmful` verdict allows execution; `may_be_harmful` still requires approval; `harmful` blocks execution.
- The LLM returns a short risk analysis. It appears in the approval prompt when you are still asked, in the reason given to the agent when a command is blocked, and in the expanded review entry.
- Missing models, authentication errors, timeouts, cancellations, and invalid/incomplete responses retain the original approval requirement. LLM failures do **not** invoke the TypeSafe fail-open policy.

The LLM has no tools. It receives:

- the command, working directory, source, and TypeSafe's classification and confidence;
- your three most recent messages to the agent, each truncated to 2,000 characters, so it can tell work you asked for, such as "clean the build output", from surprises;
- the agent's own explanation in the message that issued the command, truncated to 1,000 characters. This is treated as a claim to check against the facts, never as authorization;
- the Git state of the repository containing the working directory: every uncommitted change (staged, unstaged, or untracked; up to 200 paths), each marked with:
  - `editedByAgentThisSession`: the agent changed the file through pi's `edit` or `write` tools in this session, and the call succeeded;
  - `changedBeforeSession`: the file already had uncommitted changes when the session started or resumed, so it may hold your own work.

It never receives assistant replies other than that explanation, tool output, file contents, or the rest of the conversation.

The Git state lets the judge decide what a discarding command (`git checkout -- <path>`, `git restore`, `git reset --hard`, `git clean`, `rm`, and similar) would actually lose, instead of guessing:

| What the command would discard | Verdict |
| --- | --- |
| Nothing uncommitted, for example reverting an unchanged file | Judged on its other effects |
| Only the agent's own edits from this session, as a reasonable step toward your request | Runs without asking |
| Changes from before the session, changes the agent did not make, or anything it cannot pin down | Asks you, unless your recent messages explicitly request that discard |

Some limits err on the side of asking you:

- On a resumed session, the agent's earlier edits count as pre-existing.
- Files the agent changed through bash, for example `sed -i`, do not count as agent edits.
- Outside Git, when the change list is truncated, or when `git` fails, the judge assumes uncommitted work may exist.
- History it cannot see, such as commits, branches, and stashes, is treated as potentially valuable.

The guard runs two `git` commands (a 3-second timeout each) once at session start and again for each escalated command.

Your recent messages never authorize clearly malicious or catastrophic commands. If the model cannot establish safety, it is instructed to return `may_be_harmful`. Reasoning models are called with low reasoning effort. An LLM verdict is still a judgment, not a security guarantee. Escalations add latency and provider usage charges; their model, verdict/failure, and duration appear in the review entry, alongside the original TypeSafe confidence and raw classification.

`fallbackTimeoutMs` is a positive integer, defaults to 30 seconds, and bounds the additional wait. Set `fallbackModel` to `null` or `""`, or omit it, to disable escalation. Settings use the same directory override and session-start loading behavior described below.

## Confirmation bell

By default, the guard rings the terminal bell once when an approval prompt is waiting for your input, including low-confidence safe results that require review. With LLM risk review enabled, it rings only if the LLM still requires approval. This applies to both agent bash calls and user `!`/`!!` commands. It does not ring for routine reviews, harmful-command blocks, RPC clients, or non-interactive output.

To disable it, create `~/.pi/agent/typesafe-bash-guard.json`:

```json
{
  "bell": false
}
```

Set `"bell": true` to enable it again. If `PI_CODING_AGENT_DIR` is set, the file is read from that directory instead. Settings are loaded on session start; restart pi or run `/reload` after editing the file. A missing file or omitted `bell` defaults to on. Invalid settings produce a warning, default the bell to on, and disable any settings-file LLM fallback.

The bell uses the standard terminal BEL character. Your terminal's bell settings determine whether it plays a sound, flashes, or displays a notification; a muted terminal may ignore it.

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

Each classification sends the complete command, its working directory, and its source (`agent` or `user`) to TypeSafe. When LLM risk review is configured and triggered, those details are also sent to the selected model's provider, along with TypeSafe's verdict, your three most recent messages to the agent, the agent's explanation for the command, and the paths and Git status codes of uncommitted files in the repository (not their contents). Do not install this extension if those details must not leave your machine.

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

This favors availability over security. A classifier outage therefore weakens the guard. While the guard is enabled, commands classified as `harmful` are never overridable; `may_be_harmful` commands still require confirmation. `/typeguard off` explicitly bypasses the guard for subsequent commands in the current session.

Classification requests have a five-second timeout and do not retry, avoiding long delays before each command.

## Development

From this extension's directory:

```sh
pnpm test
pnpm run check:load
```
