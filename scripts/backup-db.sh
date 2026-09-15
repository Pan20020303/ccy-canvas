#!/usr/bin/env bash
# Dump the PostgreSQL database to a timestamped gzip file.
# Recommended cron: 0 3 * * * /opt/ccy-canvas/scripts/backup-db.sh

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/ccy-canvas}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/ccy-canvas-$TS.sql.gz"

docker exec ccy-canvas-postgres pg_dump -U postgres ccy_canvas | gzip > "$OUT"
echo "Wrote $OUT ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes)"

# Prune old backups.
find "$BACKUP_DIR" -type f -name 'ccy-canvas-*.sql.gz' -mtime +"$RETAIN_DAYS" -delete
echo "Pruned backups older than ${RETAIN_DAYS}d in $BACKUP_DIR"
