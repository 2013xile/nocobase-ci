#!/usr/bin/env bash
set -euo pipefail
[[ "$PR" =~ ^[1-9][0-9]*$ && "$HEAD_SHA" =~ ^[a-f0-9]{40}$ ]]
pr_json="$(gh api "repos/$REPOSITORY/pulls/$PR")"
if jq -e --arg repo "$REPOSITORY" --arg head "$HEAD_SHA" '
  .state == "open" and .head.repo.full_name == $repo and
  .head.sha == $head and (.head.ref | test("^agent/PM-[0-9]+$"))
' <<<"$pr_json" >/dev/null; then
  echo "eligible=true" >> "$GITHUB_OUTPUT"
  jq -r '"labeled=" + (any(.labels[]; .name == "no-preview") | tostring)' <<<"$pr_json" >> "$GITHUB_OUTPUT"
else
  echo "eligible=false" >> "$GITHUB_OUTPUT"
  echo 'Preview skipped: only the current head of an open, same-repository agent/PM-<number> PR is eligible.' >> "$GITHUB_STEP_SUMMARY"
fi
