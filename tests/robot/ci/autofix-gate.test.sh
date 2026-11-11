#!/usr/bin/env bash
# Test autofix-gate.sh on a throw-away repository. Run: bash tests/robot/ci/autofix-gate.test.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$TMP" && git init -q && git config user.email t@t && git config user.name t
mkdir -p supabase/functions/run-doctor supabase/functions/dodo-webhook supabase/sql .github/workflows tests/robot/ci
printf 'const a = 1;\nfunction pay() { checkout(); }\n' > index.html
echo 'x' > supabase/functions/run-doctor/index.ts
echo 'x' > supabase/functions/dodo-webhook/index.ts
git add -A && git commit -qm base && git branch -q base
fail=0
case_() { # $1 name, $2 want, then commands that make the change
  local name="$1" want="$2"; shift 2
  git checkout -q -B t base
  eval "$@"; git add -A; git commit -qm change --allow-empty
  got=$(bash "$DIR/autofix-gate.sh" base t | tail -1)
  if [ "$got" = "$want" ]; then echo "ok   - $name"; else echo "FAIL - $name (got $got, want $want)"; fail=1; fi
}
case_ "plain front-end fix is safe"        safe  "sed -i 's/a = 1/a = 2/' index.html"
case_ "edge function fix is safe"          safe  "echo y >> supabase/functions/run-doctor/index.ts"
case_ "payment code in index.html: owner"  owner "sed -i 's/checkout()/checkout(1)/' index.html"
case_ "payment function: owner"            owner "echo y >> supabase/functions/dodo-webhook/index.ts"
case_ "database migration: owner"          owner "echo 'select 1;' > supabase/sql/x.sql"
case_ "workflow change: owner"             owner "echo 'on: push' > .github/workflows/x.yml"
case_ "robot gate change: owner"           owner "echo 'echo safe' > tests/robot/ci/autofix-gate.sh"
case_ "sign-in code: owner"                owner "echo 'sb.auth.signInWithPassword()' >> index.html"
case_ "table change in a function: owner"  owner "echo 'alter table x add y' >> supabase/functions/run-doctor/index.ts"
case_ "no change: owner"                   owner "true"
exit $fail
