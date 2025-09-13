#!/usr/bin/env bash
set -euo pipefail
msg="${1:-chore: sync from Claude}"
branch="$(git rev-parse --abbrev-ref HEAD)"
git add -A
if ! git diff --cached --quiet; then git commit -m "$msg"; fi
git pull --rebase
git push -u origin "$branch"
echo "Pushed $branch"