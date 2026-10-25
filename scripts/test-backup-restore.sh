#!/usr/bin/env bash
# The restore test (Phase 5 hardening, #59): backs up the database at
# DATABASE_URL and the store at FILE_STORAGE_DIR, restores them into a fresh
# database named <source>_restore_test and a temporary directory, and checks
# the copy with scripts/verify-restore.ts. Also checks the two refusals: a
# backup that does not match its checksums, and a target that is not empty.
#
#   npm run test:backup     (CI runs it after the end-to-end tests)
#
# The only database it creates or drops is the one whose name ends in
# _restore_test.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${FILE_STORAGE_DIR:?FILE_STORAGE_DIR is not set}"
: "${FILE_ENCRYPTION_KEY:?FILE_ENCRYPTION_KEY is not set}"

restore_url=$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.delete("schema");
  u.pathname = "/" + decodeURIComponent(u.pathname.slice(1)).replace(/_test$/, "") + "_restore_test";
  console.log(u.toString());')
restore_db=$(node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).pathname.slice(1)))' "$restore_url")
case "$restore_db" in *_restore_test) ;; *) echo "refusing: $restore_db does not end in _restore_test" >&2; exit 1 ;; esac
source_url=$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
psql "$source_url" -qc "DROP DATABASE IF EXISTS \"$restore_db\"" -c "CREATE DATABASE \"$restore_db\""

backup=$(BACKUP_DIR="$work/backups" scripts/backup.sh)
echo "backed up to $backup"

cp -r "$backup" "$work/corrupt"
printf 'x' >> "$work/corrupt/files.tar"
if RESTORE_DATABASE_URL="$restore_url" RESTORE_FILE_STORAGE_DIR="$work/files" scripts/restore.sh "$work/corrupt" >/dev/null 2>&1; then
  echo "FAIL: a backup that does not match its checksums was restored" >&2; exit 1
fi

RESTORE_DATABASE_URL="$restore_url" RESTORE_FILE_STORAGE_DIR="$work/files" scripts/restore.sh "$backup"
RESTORE_DATABASE_URL="$restore_url" RESTORE_FILE_STORAGE_DIR="$work/files" npx tsx scripts/verify-restore.ts --expect-identical

if RESTORE_DATABASE_URL="$restore_url" RESTORE_FILE_STORAGE_DIR="$work/other" scripts/restore.sh "$backup" >/dev/null 2>&1; then
  echo "FAIL: a restore wrote over a database that was not empty" >&2; exit 1
fi
psql "$source_url" -qc "DROP DATABASE \"$restore_db\""
echo "restore test passed"
