# Pi extensions

A collection of pi extensions. Each extension lives in its own independently installable package under [`extensions/`](./extensions).

## Extensions

| Extension | Description |
| --- | --- |
| [`codex-fast-mode`](./extensions/codex-fast-mode) | Controls fast and standard modes for supported OpenAI Codex models. |
| [`codex-usage`](./extensions/codex-usage) | Displays remaining Codex subscription quota in the footer. |
| [`git-status`](./extensions/git-status) | Displays branch, worktree, and file status alongside token usage in the footer. |
| [`silicon-valley`](./extensions/silicon-valley) | Displays a random *Silicon Valley* quote when a pi session starts. |

## Install

Install every extension in this collection:

```sh
pi install .
```

Install one extension from this checkout:

```sh
pi install ./extensions/codex-fast-mode
pi install ./extensions/codex-usage
pi install ./extensions/git-status
pi install ./extensions/silicon-valley
```

Install a published extension from npm:

```sh
pi install npm:@gowthamgts/pi-codex-fast-mode
pi install npm:@gowthamgts/pi-codex-usage
pi install npm:@gowthamgts/pi-git-status
pi install npm:@gowthamgts/pi-silicon-valley
```

Restart pi or run `/reload` after installing an extension.

## Usage

- **Codex fast mode:** Select a supported `openai-codex` model, then use `/fast on`, `/fast off`, or `/fast status`. New sessions default to fast mode.
- **Codex usage:** Sign in to the `openai-codex` provider with ChatGPT. The footer automatically shows the remaining weekly quota and, at 25% or below, the reset countdown.
- **Git status:** Start pi inside a Git repository. The footer automatically shows the branch, ahead/behind and file counts. In a linked worktree it also shows `@ <worktree-directory>`; the main worktree keeps the branch-only display.
- **Silicon Valley:** A random quote appears whenever a new pi session starts.

`codex-usage` and `git-status` both provide a custom footer, and pi displays only one custom footer at a time. Install or enable the one you want to use. See each extension's linked README for display details, authentication notes, and supported models.

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

Run checks across all extension workspaces:

```sh
pnpm test
pnpm run check:load
```
