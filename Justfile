set export
set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# Install the workspace dependencies for local development.
dev:
    pnpm install

# Run tests and verify that every extension loads in pi.
check:
    pnpm test
    pnpm run check:load

# Compare workspace versions with npm's latest versions.
status:
    #!/usr/bin/env bash
    set -euo pipefail
    for manifest in extensions/*/package.json; do
      name=$(node -p "require('./$manifest').name")
      local_version=$(node -p "require('./$manifest').version")
      if remote_version=$(npm view "$name" version --json 2>/dev/null); then
        remote_version=${remote_version//\"/}
        if [[ "$local_version" == "$remote_version" ]]; then
          state="published"
        else
          state="pending"
        fi
      else
        remote_version="—"
        state="unpublished"
      fi
      printf "%-42s local=%-10s npm=%-10s %s\n" \
        "$name" "$local_version" "$remote_version" "$state"
    done

# Bump one extension: just bump codex-usage [patch|minor|major].
bump package level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    case "$level" in
      patch|minor|major) ;;
      *) echo "level must be patch, minor, or major" >&2; exit 2 ;;
    esac
    directory="extensions/$package"
    [[ -f "$directory/package.json" ]] || {
      echo "unknown extension: $package" >&2
      exit 2
    }
    (cd "$directory" && npm version "$level" --no-git-tag-version)

# Preview each package tarball without writing .tgz files.
pack-dry-run: check
    @for directory in extensions/*; do \
      echo "==> $$directory"; \
      (cd "$$directory" && npm pack --dry-run); \
    done

# Run the full release validation without publishing.
release-dry-run: check
    #!/usr/bin/env bash
    set -euo pipefail
    npm whoami
    for manifest in extensions/*/package.json; do
      directory=${manifest%/package.json}
      name=$(node -p "require('./$manifest').name")
      version=$(node -p "require('./$manifest').version")
      if npm view "$name@$version" version >/dev/null 2>&1; then
        echo "==> Skipping $name@$version (already published)"
      else
        echo "==> Previewing $name@$version"
        (cd "$directory" && npm publish --dry-run)
      fi
    done

# Publish every workspace version not already on npm.
release: check
    #!/usr/bin/env bash
    set -euo pipefail
    npm whoami
    for manifest in extensions/*/package.json; do
      directory=${manifest%/package.json}
      name=$(node -p "require('./$manifest').name")
      version=$(node -p "require('./$manifest').version")
      if npm view "$name@$version" version >/dev/null 2>&1; then
        echo "==> Skipping $name@$version (already published)"
      else
        echo "==> Publishing $name@$version"
        (cd "$directory" && npm publish)
      fi
    done
