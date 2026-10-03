# Pi extensions

A collection of pi extensions. Each extension lives in its own independently installable package under [`extensions/`](./extensions).

## Extensions

| Extension | Description |
| --- | --- |
| [`codex-fast-mode`](./extensions/codex-fast-mode) | Controls fast and standard modes for supported OpenAI Codex models. |
| [`codex-usage`](./extensions/codex-usage) | Displays remaining Codex subscription quota in the footer. |
| [`git-commit`](./extensions/git-commit) | Stages changes and commits them with a short AI-written subject. |
| [`git-status`](./extensions/git-status) | Displays branch, worktree, and file status alongside token usage in the footer. |
| [`silicon-valley`](./extensions/silicon-valley) | Displays a random *Silicon Valley* quote when a pi session starts. |
| [`typesafe-bash-guard`](./extensions/typesafe-bash-guard) | Reviews bash commands with TypeSafe AI and gates potentially harmful execution. |

## Install

Install every extension in this collection:

```sh
pi install .
```

Install one extension from this checkout:

```sh
pi install ./extensions/codex-fast-mode
pi install ./extensions/codex-usage
pi install ./extensions/git-commit
pi install ./extensions/git-status
pi install ./extensions/silicon-valley
pi install ./extensions/typesafe-bash-guard
```

Install a published extension from npm:

```sh
pi install npm:@gowthamgts/pi-codex-fast-mode
pi install npm:@gowthamgts/pi-codex-usage
pi install npm:@gowthamgts/pi-git-commit
pi install npm:@gowthamgts/pi-git-status
pi install npm:@gowthamgts/pi-silicon-valley
pi install npm:@gowthamgts/pi-typesafe-bash-guard
```

Restart pi or run `/reload` after installing an extension.

## Usage

- **Codex fast mode:** Select an `openai` Responses model or a legacy `openai-codex` model, then use `/fast on`, `/fast off`, or `/fast status`. Your selection persists across sessions.
- **Codex usage:** For `openai`, sign in to both `openai` and `openai-codex` with the same ChatGPT account/workspace: the companion Codex login reads plan quotas after the active app registration is verified. For legacy `openai-codex` sessions, its own login suffices. The footer shows the remaining five-hour and weekly quotas and, when the five-hour quota is at 25% or below, its reset countdown. API-key-only `openai` sessions do not show a subscription quota.
- **Git commit:** Run `/commit` in a Git repository to stage all changes and commit them with a lowercase AI-written subject of at most 40 characters.
- **Git status:** Start pi inside a Git repository. The footer automatically shows the branch, ahead/behind and file counts. In a linked worktree it also shows `@ <worktree-directory>`; the main worktree keeps the branch-only display.
- **Silicon Valley:** A random quote appears whenever a new pi session starts.
- **TypeSafe bash guard:** Set `TYPESAFE_API_KEY` to a plaintext key or 1Password `op://...` reference; agent and user bash commands are then reviewed before execution, with confirmation required for potentially harmful commands and harmful commands blocked.

`codex-usage` publishes its quota as an extension status, so it can be used together with `git-status`; the Git footer preserves pi's token, cache-hit, cost, context, model, and extension-status information. See each extension's linked README for display details, authentication notes, and supported models.

## Add an extension

Create a separate directory for every extension:

```text
extensions/
└── my-extension/
    ├── index.ts
    ├── package.json
    ├── README.md
    ├── LICENSE
    └── tests/
```

Name publishable packages `@gowthamgts/<package-name>`, configure public scoped publishing, include the repository metadata and Pi's required `pi-package` discovery keyword, use the MIT license by default, and add the extension package to the table above.

## Development

Set up the workspace dependencies:

```sh
just dev
```

Run checks across all extension workspaces:

```sh
just check
```

## Release

Check local versions against npm and preview the release:

```sh
just status
just release-dry-run
```

Bump an extension, then review and commit the change:

```sh
just bump codex-usage patch
```

From a clean `main` branch, publish every workspace version that is not already on npm in one run:

```sh
just release
```

The recipe runs the validation pipeline, skips versions that are already published, and invokes `npm publish` directly for each remaining extension.

Run `just --list` to see the remaining release helpers.
