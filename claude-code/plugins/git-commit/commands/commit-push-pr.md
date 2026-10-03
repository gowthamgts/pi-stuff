---
description: Commit all changes, push, and open a pull request
allowed-tools: Bash(git add:*), Bash(git diff:*), Bash(git status:*), Bash(git commit:*), Bash(git push:*), Bash(git branch:*), Bash(git switch:*), Bash(git log:*), Bash(git remote:*), Bash(gh pr:*), Bash(gh repo view:*), Bash(fj pr:*), Bash(fj repo view:*), Bash(git symbolic-ref:*)
---

1. Detect the forge from the push remote's host (`git remote get-url origin`): `github.com` means GitHub, use `gh`. Any other host is assumed to be Forgejo/Gitea, use `fj` (forgejo-cli). If the needed CLI is not installed, say so and stop after pushing.
2. Determine the default branch: on GitHub `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; on Forgejo `git symbolic-ref --short refs/remotes/origin/HEAD` with the `origin/` prefix removed (fall back to `main`). Get the current branch with `git branch --show-current`.
3. Run `git add -A`, then `git diff --cached --no-ext-diff --no-textconv --unified=2`. If the diff is empty and there are no unpushed commits, say "Nothing to commit" and stop.
4. If the current branch is the default branch, create and switch to a new short kebab-case branch named for the change (`git switch -c <name>`) before committing.
5. If there are staged changes, write a one-line commit subject. Subject rules: lowercase only, imperative mood, describe the change (not the process), at most 40 characters including any prefix, no trailing punctuation, quotes, or markdown. Run `git commit -m "<subject>"`. If it fails, report the error and stop.
6. Push with `git push -u origin HEAD`. Never force-push.
7. Check for an existing open PR for this branch (GitHub: `gh pr view`; Forgejo: `fj pr search <branch>` and match on the head branch). If one exists, report its URL and stop.
8. Otherwise create the PR with a concise title and short body summarizing the commits (`git log <default>..HEAD`):
   - GitHub: `gh pr create --title "<title>" --body "<body>"` (or `--fill` for a single commit).
   - Forgejo: `fj pr create "<title>" --body "<body>" --base <default> --head <branch>` (or `--autofill`). Always pass `--body`/`--autofill` so it doesn't open an editor.

Finish with the PR URL (on Forgejo, `fj pr view` if the create output has none).
