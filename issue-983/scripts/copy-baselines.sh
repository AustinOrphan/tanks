#!/bin/bash
# Copy the screens baselines that changed between origin/main and HEAD into media-983/screens/.
# Read-only against the repository: git show and git diff only.
set -euo pipefail
REPO=/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow
OUT=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-983/screens
mkdir -p "$OUT"
cd "$REPO"
git diff --name-status origin/main HEAD -- tools/screens/baseline/ > "$OUT/../screens-changed.txt"
while read -r status path; do
  name=$(basename "$path" .json)
  if [ "$status" != "A" ]; then
    git show "origin/main:$path" > "$OUT/$name.before.json"
  fi
  if [ "$status" != "D" ]; then
    git show "HEAD:$path" > "$OUT/$name.after.json"
  fi
  if [ "$status" = "M" ]; then
    git diff origin/main HEAD -- "$path" > "$OUT/$name.diff" || true
  fi
  echo "$status $path"
done < "$OUT/../screens-changed.txt"
