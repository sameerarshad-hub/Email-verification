#!/bin/bash
# Daemon launcher: starts supervisor in fully detached background
LOG=/home/z/my-project/server.log
nohup bash -c '
  while true; do
    echo "[$(date)] Starting server..."
    cd /home/z/my-project
    env NODE_ENV=production PORT=3000 node .next/standalone/server.js 2>&1
    EXIT=$?
    echo "[$(date)] Server exited ($EXIT), restarting in 3s..."
    sleep 3
  done
' > "$LOG" 2>&1 &
disown
echo "Supervisor PID: $!"
