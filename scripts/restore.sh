#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into an EMPTY database and an
# EMPTY directory (Phase 5, #59):
#
#   RESTORE_DATABASE_URL=… RESTORE_FILE_STORAGE_DIR=… scripts/restore.sh <backup dir>
#
# It never restores over data: a target database with any table in it, or a
# target directory with any file in it, is refused. Create a new database to
# restore into. Checks SHA256SUMS before touching anything. Then run
# `npx tsx scripts/verify-restore.ts` against the restored copy.
set -euo pipefail

src="${1:?usage: scripts/restore.sh <backup dir>}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is not set}"
: "${RESTORE_FILE_STORAGE_DIR:?RESTORE_FILE_STORAGE_DIR is not set}"
url=$(printf '%s' "$RESTORE_DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')

(cd "$src" && sha256sum --check --quiet SHA256SUMS) || { echo "restore refused: the backup does not match its SHA256SUMS" >&2; exit 1; }

tables=$(psql "$url" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$tables" = "0" ] || { echo "restore refused: the target database is not empty ($tables tables)" >&2; exit 1; }
if [ -d "$RESTORE_FILE_STORAGE_DIR" ] && [ -n "$(ls -A "$RESTORE_FILE_STORAGE_DIR")" ]; then
  echo "restore refused: $RESTORE_FILE_STORAGE_DIR is not empty" >&2
  exit 1
fi

pg_restore --no-owner --no-privileges --exit-on-error --dbname="$url" "$src/db.dump"
mkdir -p "$RESTORE_FILE_STORAGE_DIR"
chmod 700 "$RESTORE_FILE_STORAGE_DIR"
tar -C "$RESTORE_FILE_STORAGE_DIR" -xf "$src/files.tar"
echo "restored $src"
