#!/bin/sh
# dev helper: restart the server in the background
cd "$(dirname "$0")/.."
[ -f /tmp/db.pid ] && kill $(cat /tmp/db.pid) 2>/dev/null
sleep 0.5
setsid nohup node dist/server.js > /tmp/db.log 2>&1 &
echo $! > /tmp/db.pid
sleep 2.5
