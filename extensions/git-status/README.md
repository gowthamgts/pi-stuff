# pi-git-status

A [pi](https://github.com/earendil-works/pi) extension that displays Git status on the same footer line as token usage.

It shows:

- the current branch, or abbreviated commit when HEAD is detached
- upstream ahead/behind counts
- total changed files
- staged, modified, untracked, and conflicted file counts

Examples:

```text
git main • clean
git feature/auth ↑2 ↓1 • 5 changed • 2 staged • 2 modified • 1 untracked
git main • Δ5 +2 ~2 ?1
```

The display refreshes every two seconds and immediately after pi tool executions and turns. It stays hidden outside Git repositories and uses a compact layout when the terminal is narrow.

The extension uses pi's public custom-footer API—no pi source modification is required. Because pi supports one custom footer at a time, another extension that calls `setFooter()` can replace this footer (and vice versa).

## Install

From npm:

```sh
pi install npm:@gowthamgts/pi-git-status
```

From this repository:

```sh
pi install ./extensions/git-status
```

Or try it without installing:

```sh
pi -e ./extensions/git-status/index.ts
```

## Development

From this extension's directory:

```sh
pnpm test
pnpm run check:load
```
