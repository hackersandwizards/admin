#!/bin/zsh
# usage, detached: nohup net-watch.sh <run dir> </dev/null >/dev/null 2>&1 &
# Relaunches a run of <run dir>/runs (one `<name> <repo dir> <account>` line each, read every
# minute) that ended non-zero, not by a stop (143), with a connection failure in its last lines,
# once the API answers again; at most four times a run, for two days. DRY=1 checks once and
# relaunches nothing.
S=${1:a}; cd $S || exit 1
R=${0:a:h}
NOTE="

A previous run of this brief was cut off by a lost internet connection: read git log, origin/main and the working tree for what it already committed or left, finish from there, never redo committed work, and push what it could not push."
online(){ [ "$DRY" = 1 ] && return 0; [ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.anthropic.com/)" != 000 ]; }
died(){
  grep -aq '^EXIT ' $1.log || return 1
  [ "$DRY" = 1 ] || { pgrep -f "run.sh $S $1 " >/dev/null && return 1 }
  grep -aqE '^EXIT (0|143)$' $1.log && return 1
  tail -c 600 $1.log | grep -aqiE 'Connection error|ECONNRESET|ENOTFOUND|Unable to connect|fetch failed|could not resolve host'
}
end=$(( $(date +%s) + 172800 ))
while [ $(date +%s) -lt $end ]; do
  for n d a in ${=$(cat runs 2>/dev/null)}; do
    [ -f $n.log ] || continue
    died $n || continue
    c=$(cat .retries-$n 2>/dev/null || echo 0)
    [ $c -ge 4 ] && continue
    online || continue
    msg="$(date '+%H:%M:%S') relaunch $n ($((c+1)))"
    [ "$DRY" = 1 ] && { echo $msg; continue }
    echo $msg >> net-watch.log
    echo $((c+1)) > .retries-$n
    mv $n.log $n.log.$c
    (( c )) || print -r -- "$NOTE" >> $n.md
    (nohup $R/run.sh $S $n $d $a </dev/null >/dev/null 2>&1 &)
  done
  [ "$DRY" = 1 ] && exit 0
  sleep 60
done
