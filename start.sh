#!/data/data/com.termux/files/usr/bin/sh
# Keeps the bot running: restarts with backoff if it dies. Stop with: ./stop.sh
# Usage: nohup ./start.sh >/dev/null 2>&1 &
cd "$(dirname "$0")" || exit 1
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
echo $$ > .supervisor.pid
trap 'kill "$CHILD" 2>/dev/null; rm -f .supervisor.pid; exit 0' INT TERM
delay=2
while :; do
  started=$(date +%s)
  node src/server.js >> mbcb.log 2>&1 &
  CHILD=$!
  wait "$CHILD"
  code=$?
  ran=$(( $(date +%s) - started ))
  # Ran >60s = healthy run, reset backoff; otherwise double it (max 60s).
  if [ "$ran" -gt 60 ]; then delay=2; else delay=$(( delay * 2 )); [ "$delay" -gt 60 ] && delay=60; fi
  echo "$(date '+%F %T') [supervisor] server exited code=$code after ${ran}s; restart in ${delay}s" >> mbcb.log
  sleep "$delay" &
  wait $!
done
