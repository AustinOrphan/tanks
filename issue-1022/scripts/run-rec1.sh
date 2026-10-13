#!/bin/bash
# Issue #1022 evidence: record.mjs at --dpr 1 (the documented capture route), sequentially, each with its own log. Never piped through tail.
EV=/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1022/ev
WT=/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow
SEED=7
LEVEL=1
mkdir -p "$EV/logs"
cd "$WT" || exit 1

players_of() { case "$1" in ffa-2p) echo 2;; *) echo 4;; esac; }
mode_of() { case "$1" in teams-4p) echo teams;; *) echo ffa;; esac; }
flag_of() { case "$1" in reversal-ffa-4p) echo "--flag identityMarker=solid";; *) echo "";; esac; }

for arm in head main; do
  for vp in 1280x800 390x844; do
    w=${vp%x*}; h=${vp#*x}
    for c in ffa-2p ffa-4p teams-4p reversal-ffa-4p; do
      p=$(players_of $c); m=$(mode_of $c); f=$(flag_of $c)
      out="$EV/rec1/$arm/$c-$vp"
      echo "=== record $arm $c $vp"
      node tools/screens/record.mjs --flow versus-round --mode "$m" --players "$p" --bots "$p" \
        --level $LEVEL --seed $SEED --driver autoplay $f --seconds 2 --fps 2 --w "$w" --h "$h" --dpr 1 \
        --visual host-gpu --stop window --dist "$EV/$arm-dist" --timeout 180000 \
        --out "$out" --report "$out/report.json" > "$EV/logs/rec1-$arm-$c-$vp.log" 2>&1
      echo "exit=$?" >> "$EV/logs/rec1-$arm-$c-$vp.log"
      cat "$EV/logs/rec1-$arm-$c-$vp.log" | cut -c1-400
    done
  done
done

echo REC1-DONE
