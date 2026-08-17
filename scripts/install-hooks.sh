#!/bin/sh
# Installs this repo's tracked git hooks into .git/hooks (run once per clone).
set -e
cd "$(git rev-parse --show-toplevel)"
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "Installed pre-commit hook (runs 'deno task verify' before each commit)."
