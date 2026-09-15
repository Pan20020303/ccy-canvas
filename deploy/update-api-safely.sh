#!/bin/sh
# Build first. Quiesce Asynq without stopping HTTP, then recreate only when all
# active jobs finish. Queued submissions remain in Redis for the new worker.
set -eu
cd /opt/ccy-canvas
docker compose --progress plain -f compose.production.yaml build api
docker compose -f compose.production.yaml config --quiet
docker kill --signal=TSTP ccy-canvas-api >/dev/null
echo 'Queue quiesced; HTTP remains available. Waiting for in-flight tasks.'
# Stop() waits for processor loop termination, but allow its signal handler
# time to receive TSTP before reading the Redis active lists.
sleep 3
while :; do
  active=0
  for queue in text image video audio asset agent default; do
    count=$(docker exec ccy-canvas-redis redis-cli --raw LLEN "asynq:{$queue}:active")
    case "$count" in ''|*[!0-9]*) echo 'Unable to verify active queue. NOT restarting.' >&2; exit 1;; esac
    active=$((active + count))
  done
  echo "In-flight jobs: $active"
  [ "$active" -eq 0 ] && break
  sleep 5
done
docker compose -f compose.production.yaml up -d --no-deps api
echo 'API updated after draining; queued work will resume.'
