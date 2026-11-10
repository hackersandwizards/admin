#!/bin/zsh
# usage: watch.sh <run dir>
# Prints one line per run of <run dir>/runs that finished since the last line, and exits when none
# is left running.
cd ${1:a} || exit 1
while true; do
  left=0
  for n d a in ${=$(cat runs 2>/dev/null)}; do
    if grep -aq '^EXIT ' $n.log 2>/dev/null; then
      [ -e .notified-$n ] || { touch .notified-$n; echo "$n finished: $(grep -a '^EXIT' $n.log | tail -1)"; }
    else left=$((left+1)); fi
  done
  [ $left -eq 0 ] && { echo "no run left"; exit 0; }
  sleep 30
done
