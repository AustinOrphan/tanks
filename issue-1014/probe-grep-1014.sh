#!/bin/zsh
# #1014: where each probe string occurs among EVERY tracked file at HEAD (template text, docs, tests,
# tools and mutation manifests included). These are the exact commands that wrote probe-grep-N.txt;
# each was run as its own plain command from the worktree.
W=/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow
M=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1014
git -C "$W" grep -n -F -e 'Restart, losing this round?' -- . > "$M/probe-grep-1.txt"
git -C "$W" grep -n -F -e 'Reroll, losing this round?' -- . > "$M/probe-grep-2.txt"
git -C "$W" grep -n -F -e 'Restart this round?' -- . > "$M/probe-grep-3.txt"
git -C "$W" grep -n -F -e 'Session: none simulating (no seed to report)' -- . > "$M/probe-grep-4.txt"
git -C "$W" grep -n -F -e '## Tanks! session diagnostics' -- . > "$M/probe-grep-5.txt"
git -C "$W" grep -n -F -e 'has not simulated a tick yet' -- . > "$M/probe-grep-6.txt"
git -C "$W" grep -n -F -e 'there is no game canvas to save' -- . > "$M/probe-grep-7.txt"
