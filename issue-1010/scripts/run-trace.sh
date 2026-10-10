#!/bin/sh
# #1010 criterion 9: re-run the golden-trace confinement from the worktree's current HEAD.
# "old" = the real traceText() with only arena-01 swapped in-process for its c200cf62 data;
# "new" = the tree's own data. Then the direct dump comparison. Writes under this folder only.
set -u
TREE=/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow
W10=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1010
S=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1010-scripts
mkdir -p "$S/trace"
cd "$TREE" || exit 1
npx vite-node "$W10/dump-trace.ts" -- --patch base --out "$S/trace/trace-old.txt" > "$S/trace/trace-old.json" 2> "$S/trace/trace-old.err"
echo "old exit $?"
npx vite-node "$W10/dump-trace.ts" -- --patch none --out "$S/trace/trace-new.txt" > "$S/trace/trace-new.json" 2> "$S/trace/trace-new.err"
echo "new exit $?"
node "$W10/compare-trace.mjs" "$S/trace/trace-old.txt" "$S/trace/trace-new.txt" --arena 0 --arenas 9 --seeds 6 > "$S/trace/trace-compare.txt" 2>&1
echo "compare exit $?"
