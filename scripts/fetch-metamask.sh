#!/usr/bin/env bash
# Fetch + extract the MetaMask build that Synpress expects, into .cache-synpress/.
#
# Synpress does this itself, but its pure-JS unzip pegs a core at ~96% CPU and
# effectively never finishes (especially with the project on a /mnt/c drvfs
# mount under WSL). Doing it with curl + a native unzip takes seconds, and
# Synpress's own downloadFile/unzipArchive both no-op when the files exist.
set -euo pipefail

VERSION="${METAMASK_VERSION:-13.13.1}"
CACHE_DIR="$(cd "$(dirname "$0")/.." && pwd)/.cache-synpress"
ZIP="$CACHE_DIR/metamask-chrome-$VERSION.zip"
DIR="$CACHE_DIR/metamask-chrome-$VERSION"

mkdir -p "$CACHE_DIR"

if [ ! -f "$ZIP" ]; then
  echo "==> downloading MetaMask $VERSION"
  curl -fL --retry 3 --max-time 300 \
    "https://github.com/MetaMask/metamask-extension/releases/download/v$VERSION/metamask-chrome-$VERSION.zip" \
    -o "$ZIP"
fi

if [ ! -f "$DIR/manifest.json" ]; then
  echo "==> extracting to $DIR"
  rm -rf "$DIR"
  mkdir -p "$DIR"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$ZIP" -d "$DIR"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$DIR"
  else
    echo "need 'unzip' or 'python3' to extract the MetaMask archive" >&2
    exit 1
  fi
fi

echo "==> MetaMask ready: $DIR ($(find "$DIR" -type f | wc -l) files)"
