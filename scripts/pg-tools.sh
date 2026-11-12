# Sourced by scripts/backup.sh and scripts/restore.sh (#184). Sets PG_BIN to
# the directory of the PostgreSQL client tools whose major version is the
# server's: a newer pg_restore sets parameters an older server refuses
# (transaction_timeout, from 17), and an older one cannot read a newer dump.
#
#   PG_BIN       use these tools, as they are (an operator's choice)
#   PG_LIB_DIR   where versioned tools are installed (default /usr/lib/postgresql,
#                as Debian and Ubuntu install postgresql-client-<major>)
pg_tools_for() {
  local url="$1" server major client dir
  if [ -n "${PG_BIN:-}" ]; then return 0; fi
  server=$(psql "$url" -Atc 'SHOW server_version_num') || { echo "refused: the database cannot be reached" >&2; return 1; }
  major=$((server / 10000))
  dir="${PG_LIB_DIR:-/usr/lib/postgresql}/$major/bin"
  if [ -x "$dir/pg_dump" ] && [ -x "$dir/pg_restore" ]; then
    PG_BIN="$dir"
    return 0
  fi
  client=$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  if [ "$client" = "$major" ]; then
    PG_BIN=$(dirname "$(command -v pg_dump)")
    return 0
  fi
  echo "refused: the server is PostgreSQL $major and pg_dump on PATH is ${client:-missing}; install postgresql-client-$major, or set PG_BIN to its tools" >&2
  return 1
}
