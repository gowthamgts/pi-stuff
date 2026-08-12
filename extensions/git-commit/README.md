# pi-git-commit

A [pi](https://github.com/earendil-works/pi) extension that stages the current Git changes and commits them with a concise AI-written subject.

## Usage

Run:

```text
/commit
```

The command:

1. stages tracked, untracked, and deleted files with `git add -A`
2. sends the staged diff to the currently selected model
3. creates a commit with the generated subject

Subjects are lowercase, imperative, free of trailing punctuation, and limited to 40 characters. If generation or `git commit` fails, the changes remain staged.

## Install

From npm:

```sh
pi install npm:@gowthamgts/pi-git-commit
```

From this repository:

```sh
pi install ./extensions/git-commit
```

Or try it without installing:

```sh
pi -e ./extensions/git-commit/index.ts
```

## Development

From this extension's directory:

```sh
pnpm test
pnpm run check:load
```
