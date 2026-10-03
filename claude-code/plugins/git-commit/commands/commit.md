---
description: Stage all changes and commit with a short AI-written subject
allowed-tools: Bash(git add:*), Bash(git diff:*), Bash(git status:*), Bash(git commit:*)
---

1. Run `git add -A`.
2. Run `git diff --cached --no-ext-diff --no-textconv --unified=2`. If it is empty, say "Nothing to commit" and stop.
3. Write a one-line commit subject for the staged diff. Subject rules: lowercase only, imperative mood, describe the change (not the process), at most 40 characters including any prefix, no trailing punctuation, quotes, or markdown.
4. Run `git commit -m "<subject>"`. If it fails, report the error and leave the changes staged.

Do nothing else and send no other text besides a one-line confirmation.
