#!/bin/bash
cd /app/conversations/6a71a3b411d246064738225d
URL="https://kestrel-ed63dc1c.base44.app/functions/importMseBatch"
for f in chunks/chunk_*.json; do
  name=$(basename $f)
  for attempt in 1 2 3; do
    resp=$(curl -s --max-time 300 -X POST "$URL" -H "Content-Type: application/json" -d @$f)
    if echo "$resp" | grep -q '"success":true'; then
      echo "$name OK (attempt $attempt): $(echo $resp | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["days_processed"], "days,", r["duration_seconds"], "s")')"
      break
    else
      echo "$name FAIL (attempt $attempt): $(echo $resp | head -c 150)"
      if [ $attempt -lt 3 ]; then sleep 120; fi
    fi
  done
  sleep 75
done
echo "ALL DONE"
