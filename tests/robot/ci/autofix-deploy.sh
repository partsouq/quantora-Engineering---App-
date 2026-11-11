#!/usr/bin/env bash
# Deploy a commit that the auto-fix workflow pushed to main (2026-11-11).
# A push made with the workflow's own token does not start other workflows, so this does it:
#   - website: waits for the GitHub Pages build of that commit (asks for one if none starts)
#   - server functions: runs "Deploy server functions" for each changed function and waits for it
# Usage: autofix-deploy.sh <sha> <site_changed 0|1> "<function names>"
# Needs GH_TOKEN and GH_REPO.
set -u
SHA="$1"; SITE="$2"; FUNCS="${3:-}"
fail=0

if [ "$SITE" = 1 ]; then
  echo "Waiting for the website build of $SHA"
  asked=0
  for i in $(seq 1 40); do
    read -r c s <<< "$(gh api "repos/$GH_REPO/pages/builds/latest" --jq '.commit+" "+.status' 2>/dev/null || echo "- -")"
    if [ "$c" = "$SHA" ] && [ "$s" = "built" ]; then echo "website built"; break; fi
    if [ "$c" = "$SHA" ] && [ "$s" = "errored" ]; then echo "website build failed"; fail=1; break; fi
    if [ "$i" = 6 ] && [ "$asked" = 0 ] && [ "$c" != "$SHA" ]; then
      echo "no build started: asking for one"; gh api -X POST "repos/$GH_REPO/pages/builds" >/dev/null || true; asked=1
    fi
    [ "$i" = 40 ] && { echo "website build did not finish in time"; fail=1; }
    sleep 10
  done
fi

for f in $FUNCS; do
  echo "Deploying server function $f"
  before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run deploy-functions.yml --ref main -f function="$f" || { fail=1; continue; }
  id=""
  for i in $(seq 1 30); do
    id=$(gh run list --workflow deploy-functions.yml --limit 5 --json databaseId,createdAt --jq "[.[]|select(.createdAt >= \"$before\")][0].databaseId // empty")
    [ -n "$id" ] && break; sleep 5
  done
  [ -z "$id" ] && { echo "deploy of $f did not start"; fail=1; continue; }
  gh run watch "$id" --exit-status >/dev/null && echo "$f deployed" || { echo "deploy of $f failed"; fail=1; }
done
exit $fail
