#!/bin/sh
# Installs the ohmybug CLI: one Node.js file, no dependencies.
#   curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/main/install.sh | sh
# OHMYBUG_INSTALL_DIR picks the folder (default: /usr/local/bin when writable, else ~/.local/bin).
# OHMYBUG_CLI_URL picks the file (default: main; pin a release with .../ohmybug-cli/v0.10.0/ohmybug.mjs).
set -eu
src="${OHMYBUG_CLI_URL:-https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/main/ohmybug.mjs}"
if ! command -v node >/dev/null 2>&1; then
  echo "ohmybug needs Node.js 18 or newer: https://nodejs.org" >&2; exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "ohmybug needs Node.js 18 or newer; this is $(node --version)" >&2; exit 1
fi
dir="${OHMYBUG_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$src" -o "$tmp"
head -1 "$tmp" | grep -q '^#!/usr/bin/env node' || { echo "the download is not the ohmybug CLI: $src" >&2; exit 1; }
chmod 755 "$tmp"
# Kept as .mjs, with ohmybug a link to it: Node before 22 reads an extensionless file as CommonJS.
mv "$tmp" "$dir/ohmybug.mjs"
trap - EXIT
ln -sf ohmybug.mjs "$dir/ohmybug"
echo "installed: $dir/ohmybug ($("$dir/ohmybug" --version))"
case ":$PATH:" in *":$dir:"*) ;; *) echo "add $dir to PATH to run it as ohmybug" ;; esac
