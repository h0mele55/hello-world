#!/usr/bin/env bash
# Backs up the database and the encrypted file store (Phase 5, #59):
#
#   DATABASE_URL=… FILE_STORAGE_DIR=… BACKUP_DIR=… scripts/backup.sh
#
# Writes <BACKUP_DIR>/<UTC time>/ holding db.dump (pg_dump, custom format),
# files.tar (the store as it is on disk: already encrypted) and SHA256SUMS,
# and prints that directory.
#
# What it does not hold: FILE_ENCRYPTION_KEY. Without that key the files and
# every sealed column are unreadable, so keep the key in its own place (a
# secret manager), never beside the backups. The dump still holds plain
# metadata (client names, users, password hashes): keep the backups on storage
# that is itself encrypted and access-controlled.
#
# The dump is taken first, then the files, so every file a dumped row names is
# already on disk; a file written after the dump is carried along unused.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${FILE_STORAGE_DIR:?FILE_STORAGE_DIR is not set}"
: "${BACKUP_DIR:?BACKUP_DIR is not set}"
[ -d "$FILE_STORAGE_DIR" ] || { echo "backup refused: FILE_STORAGE_DIR $FILE_STORAGE_DIR is not a directory" >&2; exit 1; }

# Prisma's ?schema= is not a libpq parameter; everything else is passed on.
url=$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')

umask 077
out="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
pg_dump --format=custom --no-owner --no-privileges --dbname="$url" --file="$out/db.dump"
tar -C "$FILE_STORAGE_DIR" -cf "$out/files.tar" .
(cd "$out" && sha256sum db.dump files.tar > SHA256SUMS)
echo "$out"
