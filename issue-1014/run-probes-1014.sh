#!/bin/zsh
# #1014: the probe against the branch's dist (all four arms), then against the origin/main copy's
# dist (the two required arms). Port 4396 is checked free before each; output goes to files.
M=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1014
T=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1014
W=/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow
cd "$M" || exit 2
(lsof -nP -iTCP:4396 -sTCP:LISTEN || echo "port 4396 free before the HEAD run") > port-check.txt
node probe-requests-1014.mjs "$W" requests-head.json "$T/downloads-head-final" --supplementary > requests-head.log 2>&1
echo "exit $?" >> requests-head.log
(lsof -nP -iTCP:4396 -sTCP:LISTEN || echo "port 4396 free before the main run") >> port-check.txt
node probe-requests-1014.mjs "$T/main-src" requests-main.json "$T/downloads-main-final" > requests-main.log 2>&1
echo "exit $?" >> requests-main.log
(lsof -nP -iTCP:4396 -sTCP:LISTEN || echo "port 4396 free after both runs") >> port-check.txt
node bytes-1014.mjs requests-head.json requests-main.json bytes.json > bytes.log 2>&1
echo "exit $?" >> bytes.log
