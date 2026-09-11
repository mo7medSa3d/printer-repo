#!/bin/sh
# Re-provision pinned PDFium artifacts (reproducible, hash-verified).
# Usage: sh agent/third_party/pdfium/fetch.sh [chromium/NNNN]
# Windows runtime files are committed; linux-x64 is build/test-only.
set -eu

TAG="${1:-chromium/8044}"
BASE="https://github.com/bblanchon/pdfium-binaries/releases/download/${TAG}"
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

want_win="78a17d9a5f14467631c26a3ac8741b27a0471ecc05bd6a119b523598160a0537"
want_linux="eb142f416aed3a72fc5a02dbd5884868a16cb99dc0cf53e6bdd64afbf67b05f4"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() {
  name="$1"; want="$2"
  echo "fetch $name ($TAG)..."
  curl -sSL -o "$TMP/$name" "$BASE/$name"
  got="$(sha256 "$TMP/$name")"
  if [ "$got" != "$want" ]; then
    echo "SHA-256 MISMATCH for $name: got $got, want $want" >&2
    exit 1
  fi
  echo "sha256 ok: $name"
}

fetch "pdfium-win-x64.tgz" "$want_win"
fetch "pdfium-linux-x64.tgz" "$want_linux"

mkdir -p "$HERE/win-x64" "$HERE/linux-x64" "$HERE/include"
tar xzf "$TMP/pdfium-win-x64.tgz" -C "$TMP"
cp "$TMP/bin/pdfium.dll" "$TMP/lib/pdfium.dll.lib" "$HERE/win-x64/"
cp "$TMP/include/fpdfview.h" "$HERE/include/"
cp "$TMP/LICENSE" "$HERE/LICENSE.pdfium"
mkdir -p "$TMP/lin"
tar xzf "$TMP/pdfium-linux-x64.tgz" -C "$TMP/lin"
cp "$TMP/lin/lib/libpdfium.so" "$HERE/linux-x64/"
echo "done. Review 'git status' and update SHAs here + README.md for new tags."
