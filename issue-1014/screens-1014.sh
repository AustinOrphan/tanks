#!/bin/zsh
# #1014 screen gate: the full checked subset against the branch's freshly built dist (it includes
# screen.devtools, screen.devtools.actions and screen.devtools.diagnostics), evidence written to
# scratch rather than into the worktree. dist is the one `npm run verify:build` just built.
W=/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow
M=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1014
cd "$W" || exit 2
ls -la dist/assets/index-*.js > "$M/screens-dist.txt"
npm run screens:check -- --dist dist --out /Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1014/screens-check-out > "$M/screens-check.log" 2>&1
echo "exit $?" >> "$M/screens-check.log"
git status --porcelain > "$M/status-after-screens.txt"
