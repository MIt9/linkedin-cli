#!/bin/sh
# Installs the linkedin CLI (single compiled binary) to ~/.local/bin and unpacks the Chrome extension into ~/.linkedin-cli/extension.
#   sh install.sh                                  (GitHub Releases of MIt9/linkedin-cli, latest)
#   LINKEDIN_CLI_BASE_URL=https://your.host/linkedin-cli sh install.sh
# The base URL serves latest.json plus the files it names (see scripts/build.ts). If the default URL answers 404, the script
# falls back to `gh release download` when gh is logged in. Safe to re-run; never uses sudo; never edits shell files.
set -eu

GH_REPO="MIt9/linkedin-cli"
DEFAULT_URL="https://github.com/$GH_REPO/releases/latest/download"
BASE_URL="${LINKEDIN_CLI_BASE_URL:-$DEFAULT_URL}"
BIN_DIR="${LINKEDIN_CLI_BIN_DIR:-$HOME/.local/bin}"
BASE_URL="${BASE_URL%/}"

die() { echo "install: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only (got $(uname -s))"
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
KEY="darwin-$ARCH"

case "$BASE_URL" in
  https://*|file://*|http://127.0.0.1*|http://localhost*) ;;
  *) die "LINKEDIN_CLI_BASE_URL must be https:// (http only for localhost)" ;;
esac
for tool in curl tar shasum plutil; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/linkedin-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() { # url dest
  if code="$(curl -fsSL --retry 2 -o "$2" -w '%{http_code}' "$1" 2>/dev/null)"; then return 0; fi
  if [ "$code" = 404 ] && [ "$BASE_URL" = "$DEFAULT_URL" ]; then
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      echo "install: HTTP 404 from the release URL; retrying with gh release download" >&2
      gh release download --repo "$GH_REPO" --pattern "$(basename "$1")" --output "$2" --clobber >/dev/null && return 0
      die "gh release download failed for $(basename "$1")"
    fi
    die "release not found (HTTP 404): $1. Check the base URL (LINKEDIN_CLI_BASE_URL) and that a release of $GH_REPO exists"
  fi
  die "download failed (HTTP ${code:-000}): $1"
}
field() { plutil -extract "$1" raw -o - "$TMP/latest.json" 2>/dev/null || die "latest.json has no $1"; }
url_of() { case "$1" in *://*) echo "$1" ;; *) echo "$BASE_URL/$1" ;; esac; }
verify() { # file expected-sha256
  got="$(shasum -a 256 "$1" | cut -d' ' -f1)"
  [ "$got" = "$2" ] || die "sha256 mismatch for $1 (expected $2, got $got); nothing was installed"
}

fetch "$BASE_URL/latest.json" "$TMP/latest.json"
VERSION="$(field version)"
BIN_URL="$(url_of "$(field "binaries.$KEY.url")")"
BIN_SHA="$(field "binaries.$KEY.sha256")"
echo "Installing linkedin $VERSION ($KEY) to $BIN_DIR"

fetch "$BIN_URL" "$TMP/bin.tar.gz"
verify "$TMP/bin.tar.gz" "$BIN_SHA"
mkdir "$TMP/bin"
tar -xzf "$TMP/bin.tar.gz" -C "$TMP/bin"
[ -f "$TMP/bin/linkedin" ] || die "archive has no linkedin binary"
chmod 755 "$TMP/bin/linkedin"
"$TMP/bin/linkedin" --help >/dev/null 2>&1 || die "the downloaded binary does not run on this machine"

mkdir -p "$BIN_DIR"
TARGET="$BIN_DIR/linkedin"
cp "$TMP/bin/linkedin" "$TARGET.new.$$"
if [ -e "$TARGET" ]; then # keep the previous binary for rollback
  rm -f "$TARGET.old"
  ln "$TARGET" "$TARGET.old" 2>/dev/null || cp "$TARGET" "$TARGET.old"
fi
mv -f "$TARGET.new.$$" "$TARGET"
xattr -d com.apple.quarantine "$TARGET" 2>/dev/null || true # unsigned binary: harmless if the attribute is absent

echo
"$TARGET" extension install --text
echo
echo "Done: linkedin $VERSION installed to $TARGET."
echo "Now finish the Chrome steps above; the last one starts the service and checks everything."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "$BIN_DIR is not in your PATH, so open a new terminal after adding this line to ~/.zshrc (not done for you):"
    if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then echo '  export PATH="$HOME/.local/bin:$PATH"'; else echo "  export PATH=\"$BIN_DIR:\$PATH\""; fi
    ;;
esac
