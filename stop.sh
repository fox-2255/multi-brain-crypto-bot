#!/data/data/com.termux/files/usr/bin/sh
cd "$(dirname "$0")" || exit 1
if [ -f .supervisor.pid ]; then kill "$(cat .supervisor.pid)" 2>/dev/null && echo "stopped"; else echo "not running (no .supervisor.pid)"; fi
