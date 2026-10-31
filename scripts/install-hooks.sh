#!/bin/sh
# Points git at the committed hooks in .githooks (run once per clone; safe to repeat).
set -eu
cd "$(git rev-parse --show-toplevel)"
chmod +x .githooks/* 2>/dev/null || true
if [ "$(git config --get core.hooksPath || true)" = .githooks ]; then
  echo "hooks: core.hooksPath already .githooks, nothing to do"
else
  git config core.hooksPath .githooks
  echo "hooks: set core.hooksPath=.githooks ($(ls .githooks | tr '\n' ' '))"
fi
