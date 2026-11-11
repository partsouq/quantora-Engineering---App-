#!/usr/bin/env bash
# Install Chromium for the robot. The runner's apt mirrors sometimes fail
# (e.g. "Temporary failure resolving security.ubuntu.com"), which used to fail
# the whole robot run. Retry the full install, then fall back to installing the
# browser alone: GitHub's ubuntu runners already ship the system libraries.
set -u
NPX="${NPX:-npx}"
TRIES="${TRIES:-3}"
WAIT="${WAIT:-20}"
for i in $(seq 1 "$TRIES"); do
  if $NPX playwright install --with-deps chromium; then
    echo "browser installed (with system deps, try $i)"; exit 0
  fi
  echo "install with system deps failed (try $i/$TRIES)"
  [ "$i" -lt "$TRIES" ] && sleep "$WAIT"
done
echo "falling back to browser-only install (system deps already on runner)"
if $NPX playwright install chromium; then
  echo "browser installed (browser only)"; exit 0
fi
echo "browser install failed"; exit 1
