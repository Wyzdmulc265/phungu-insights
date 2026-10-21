#!/bin/bash
cd /app/conversations/6a71a3b411d246064738225d
URL="https://kestrel-ed63dc1c.base44.app/functions/importMseBatch"
run_chunk() {
  f=$1
  name=$(basename $(dirname $f))/$(basename $f)
  for attempt in 1 2 3 4; do
    resp=$(curl -s --max-time 400 -X POST "$URL" -H "Content-Type: application/json" -d @$f)
    if echo "$resp" | grep -q '"success":true'; then
      echo "[$(date -u +%H:%M:%S)] $name OK (try $attempt): $(echo $resp | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["days_processed"], "days", r["duration_seconds"], "s")' 2>/dev/null)"
      return 0
    fi
    echo "[$(date -u +%H:%M:%S)] $name FAIL (try $attempt): $(echo $resp | head -c 120)"
    [ $attempt -lt 4 ] && sleep 150
  done
  echo "[$(date -u +%H:%M:%S)] $name GAVE UP"
}
echo "[$(date -u +%H:%M:%S)] supervisor start"
for f in chunks/chunk_*.json; do run_chunk "$f"; sleep 45; done
for f in chunks-sep/chunk_*.json; do run_chunk "$f"; sleep 45; done
for f in chunks-jf/chunk_*.json; do run_chunk "$f"; sleep 45; done
echo "[$(date -u +%H:%M:%S)] ALL 2025 IMPORT DONE"
