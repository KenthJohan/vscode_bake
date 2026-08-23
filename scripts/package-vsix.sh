#!/usr/bin/env bash
# Bumps the extension version, packages, and installs the latest .vsix.
# Usage: scripts/package-vsix.sh [patch|minor|major] [--no-reload]
set -euo pipefail

BUMP="patch"
RELOAD=1
if [[ "${1:-}" == "patch" || "${1:-}" == "minor" || "${1:-}" == "major" ]]; then
  BUMP="$1"
  shift
fi
if [[ "${1:-}" == "--no-reload" ]]; then
  RELOAD=0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "Invalid bump type: $BUMP (expected patch, minor, or major)" >&2
    exit 1
    ;;
esac

npm version "$BUMP" --no-git-tag-version

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"

npm run compile
npx --yes @vscode/vsce package

if ! command -v code >/dev/null 2>&1; then
  echo "The 'code' command was not found. Run 'Shell Command: Install code command in PATH' in VS Code." >&2
  echo "Package created: ${NAME}-${VERSION}.vsix"
  exit 0
fi

code --install-extension "${NAME}-${VERSION}.vsix" --force
if [[ "$RELOAD" -eq 1 ]]; then
  code --reuse-window --command workbench.action.reloadWindow || true
fi

echo "Packaged ${NAME}-${VERSION}.vsix"
