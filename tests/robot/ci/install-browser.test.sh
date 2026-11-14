#!/usr/bin/env bash
# Test install-browser.sh with a fake npx. Run: bash tests/robot/ci/install-browser.test.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
mk() { # $1 = mode: deps-ok | deps-fail | all-fail
  cat > "$TMP/npx" <<F
#!/usr/bin/env bash
echo "\$*" >> "$TMP/calls"
case "$1" in
  deps-ok) exit 0 ;;
  deps-fail) [[ "\$*" == *--with-deps* ]] && exit 100 || exit 0 ;;
  all-fail) exit 100 ;;
esac
F
  chmod +x "$TMP/npx"; : > "$TMP/calls"
}
run() { NPX="$TMP/npx" TRIES=2 WAIT=0 bash "$DIR/install-browser.sh" >/dev/null 2>&1; }
check() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3 (got $1, want $2)"; fail=1; fi; }

mk deps-ok;   run; check $? 0 "succeeds first try";      check "$(wc -l < "$TMP/calls")" 1 "only one call"
mk deps-fail; run; check $? 0 "falls back when apt fails"; check "$(tail -1 "$TMP/calls")" "playwright install chromium" "fallback is browser-only"
check "$(grep -c with-deps "$TMP/calls")" 2 "retried with deps TRIES times"
mk all-fail;  run; check $? 1 "fails when everything fails"
exit $fail
