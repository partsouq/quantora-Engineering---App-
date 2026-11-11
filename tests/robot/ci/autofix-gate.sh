#!/usr/bin/env bash
# Auto-fix safety gate (2026-11-11). Decides whether an automatic fix may go live by itself.
# Usage: autofix-gate.sh <base-ref> <head-ref>      (run inside the repository)
# Prints reasons, then a last line "safe" or "owner".
#   owner = the owner must approve: the fix touches payments, the database, sign-in, the
#           robot/test gate itself, or the GitHub workflows.
# The workflow always runs this file from main, never the copy inside the fix being checked.
set -u
BASE="$1"; HEAD="$2"
FILES=$(git diff --name-only "$BASE" "$HEAD")
if [ -z "$FILES" ]; then echo "no changes"; echo "owner"; exit 0; fi

PROTECTED_PATH='^(\.github/|supabase/sql/|supabase/migrations/|tests/robot/(robot\.js|signup\.js|ci/|package))'
PROTECTED_NAME='(dodo|razorpay|paddle|paypal|billing|payment|checkout|subscri|wallet|credit|auth|signup|sign-up|login|password)'
PROTECTED_CODE='(dodo|razorpay|paddle|paypal|checkout|subscription|billing|wallet|credit_balance|credit_transactions|signInWith|signUp|signOut|resetPasswordForEmail|updateUser\(|auth\.admin|exchangeCodeForSession|\.rpc\("?(apply|grant|admin_)|alter table|create table|drop table|create policy|drop policy|service_role)'

owner=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if echo "$f" | grep -Eq "$PROTECTED_PATH"; then echo "protected file: $f"; owner=1; continue; fi
  if echo "$f" | grep -Eiq "$PROTECTED_NAME"; then echo "payments/sign-in file: $f"; owner=1; continue; fi
done <<< "$FILES"

# changed lines (added or removed) that touch payments, sign-in or the database
HITS=$(git diff -U0 "$BASE" "$HEAD" | grep -E '^[+-]' | grep -Ev '^(\+\+\+|---) ' | grep -Eio "$PROTECTED_CODE" | sort -u | tr '\n' ' ')
if [ -n "$HITS" ]; then echo "changed lines touch payments / sign-in / database: $HITS"; owner=1; fi

if [ "$owner" = 1 ]; then echo "owner"; else echo "files: $(echo "$FILES" | tr '\n' ' ')"; echo "safe"; fi
