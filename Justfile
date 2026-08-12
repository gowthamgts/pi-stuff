set export
set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# Install the workspace dependencies for local development.
dev:
    pnpm install

# Set up dependencies, run tests, and verify that every extension loads in pi.
check: dev
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
    npm whoami
    pnpm publish -r --dry-run --no-git-checks

# Publish all versions not already on npm; pass a current npm 2FA code.
release otp: check
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "$otp" =~ ^[0-9]{6}$ ]] || {
      echo "usage: just release <six-digit-npm-otp>" >&2
      exit 2
    }
    npm whoami
    NPM_CONFIG_OTP="$otp" pnpm publish -r --publish-branch main
