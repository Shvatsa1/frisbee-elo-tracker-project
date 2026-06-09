#!/usr/bin/env bash
#
# UltiElo nightly Postgres backup.
# Per SPEC_15 §6: nightly `pg_dump`, retain 7 daily + 4 weekly, copy off-box.
# Apply this to the live DB *immediately* — independent of v2 rollout.
#
# Run on the VM under /root/ops/ (consistent with vm_cleanup.sh that
# already lives there). Add to crontab:
#
#   30 2 * * *  /root/ops/ultielo_pg_backup.sh >> /var/log/ultielo_pg_backup.log 2>&1
#
# Off-box copy is opt-in (controlled by ULTIELO_BACKUP_SCP_TARGET env
# var; if unset, backups stay local).
#
# Environment:
#   ULTIELO_DB_CONTAINER    docker compose service name running Postgres
#                           (default: db; override if your stack differs)
#   ULTIELO_DB_NAME         database to dump (default: frisbee_elo)
#   ULTIELO_DB_USER         db user (default: postgres)
#   ULTIELO_BACKUP_DIR      local backup root (default: /root/backups/ultielo)
#   ULTIELO_BACKUP_SCP_TARGET
#                           optional scp target, e.g. user@host:/backups/ultielo
#   ULTIELO_KEEP_DAILY      retention in days (default: 7)
#   ULTIELO_KEEP_WEEKLY     retention in weeks of Sunday snapshots (default: 4)

set -euo pipefail

DB_CONTAINER="${ULTIELO_DB_CONTAINER:-db}"
DB_NAME="${ULTIELO_DB_NAME:-frisbee_elo}"
DB_USER="${ULTIELO_DB_USER:-postgres}"
BACKUP_DIR="${ULTIELO_BACKUP_DIR:-/root/backups/ultielo}"
SCP_TARGET="${ULTIELO_BACKUP_SCP_TARGET:-}"
KEEP_DAILY="${ULTIELO_KEEP_DAILY:-7}"
KEEP_WEEKLY="${ULTIELO_KEEP_WEEKLY:-4}"

DAILY_DIR="$BACKUP_DIR/daily"
WEEKLY_DIR="$BACKUP_DIR/weekly"
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
DAY_OF_WEEK="$(date +%u)"   # 1..7, Mon..Sun
FILE="${DB_NAME}_${STAMP}.sql.gz"
DAILY_PATH="$DAILY_DIR/$FILE"

echo "[$(date -Iseconds)] starting pg_dump of $DB_NAME -> $DAILY_PATH"

# Prefer docker-compose service (the deployed stack); fall back to
# native pg_dump if you run Postgres directly on the host.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ( cd /root/ultielo \
    && docker compose exec -T "$DB_CONTAINER" \
         pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists ) \
    | gzip -9 > "$DAILY_PATH"
else
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip -9 > "$DAILY_PATH"
fi

# Sanity: backup must be non-empty.
if [[ ! -s "$DAILY_PATH" ]]; then
  echo "[$(date -Iseconds)] ERROR: backup file is empty" >&2
  exit 1
fi

echo "[$(date -Iseconds)] daily backup size: $(du -h "$DAILY_PATH" | cut -f1)"

# Weekly snapshot on Sunday.
if [[ "$DAY_OF_WEEK" == "7" ]]; then
  cp "$DAILY_PATH" "$WEEKLY_DIR/"
  echo "[$(date -Iseconds)] copied Sunday snapshot to $WEEKLY_DIR/"
fi

# Off-box copy.
if [[ -n "$SCP_TARGET" ]]; then
  echo "[$(date -Iseconds)] scp -> $SCP_TARGET"
  scp -q "$DAILY_PATH" "$SCP_TARGET/"
fi

# Retention.
find "$DAILY_DIR"  -name "${DB_NAME}_*.sql.gz" -type f -mtime +"$KEEP_DAILY"           -delete
find "$WEEKLY_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime +"$((KEEP_WEEKLY * 7))"  -delete

echo "[$(date -Iseconds)] done."
