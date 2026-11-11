#!/usr/bin/env bash
# Install Chromium for the robot. The runner's apt mirrors sometimes fail
# (e.g. "Temporary failure resolving security.ubuntu.com"), which used to fail
# the whole robot run. Retry the full install, then fall back to installing the
# browser alone: GitHub's ubuntu runners already ship the system libraries.
# 2026-11-11: when the mirrors don't resolve, one "--with-deps" try hangs ~10 min
# on DNS timeouts, so three tries ran past the job's 25-minute limit and the
# browser-only fallback never ran. Each try is now capped (DEPS_TIMEOUT seconds).
set -u
NPX="${NPX:-npx}"
TRIES="${TRIES:-2}"
WAIT="${WAIT:-15}"
DEPS_TIMEOUT="${DEPS_TIMEOUT:-180}"
for i in $(seq 1 "$TRIES"); do
  if timeout --kill-after=10 "$DEPS_TIMEOUT" $NPX playwright install --with-deps chromium; then
    echo "browser installed (with system deps, try $i)"; exit 0
  fi
  echo "install with system deps failed or took over ${DEPS_TIMEOUT}s (try $i/$TRIES)"
  [ "$i" -lt "$TRIES" ] && sleep "$WAIT"
done
echo "falling back to browser-only install (system deps already on runner)"
if $NPX playwright install chromium; then
  echo "browser installed (browser only)"; exit 0
fi
echo "browser install failed"; exit 1
