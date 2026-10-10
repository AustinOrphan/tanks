#!/bin/sh
# Issue #1055 visual evidence, end to end. Writes nothing inside the worktree.
#
#   sh run.sh [worktree] [before-sha] [after-sha]
#
# before = the branch's merge base with origin/main; after = the branch HEAD. Both trees get
# HEAD's tools/hud/strip-width-page.ts + strip-width.html (the harness strip-width.mjs drives)
# and this directory's cue page, so one page drives both stylesheets.
set -eu
WT=${1:-/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow}
BEFORE=${2:-c200cf621d8bbd40add83acb570c17e40faa2c08}
AFTER=${3:-441eef9477ffafbe22549a77ea1b1dba115d8117}
HERE=$(cd "$(dirname "$0")" && pwd)
M=$(dirname "$HERE")
T=$(dirname "$M")/trees-1055

mkdir -p "$T/before" "$T/after"
git -C "$WT" archive -o "$T/before.tar" "$BEFORE" src package.json tsconfig.json
git -C "$WT" archive -o "$T/after.tar" "$AFTER" src package.json tsconfig.json \
  tools/hud/strip-width-page.ts tools/hud/strip-width.html
tar -xf "$T/before.tar" -C "$T/before"
tar -xf "$T/after.tar" -C "$T/after"
mkdir -p "$T/before/tools/hud"
cp "$T/after/tools/hud/strip-width-page.ts" "$T/after/tools/hud/strip-width.html" "$T/before/tools/hud/"
ln -sfn "$WT/node_modules" "$T/before/node_modules"
ln -sfn "$WT/node_modules" "$T/after/node_modules"
# The only differing src files should be hud.css, stock-cue.ts and their tests.
diff -rq "$T/before/src" "$T/after/src" || true

node "$HERE/capture.mjs" "$WT" "$T" "$M"
node "$HERE/sheets.mjs" "$WT" "$M" "$BEFORE" "$AFTER"
