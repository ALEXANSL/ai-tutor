#!/usr/bin/env bash
# Starts an ephemeral local PostgreSQL, applies the Supabase shim and all
# migrations from supabase/migrations, runs the given command with
# DATABASE_URL set, then stops and removes the database.
#
# If TEST_DATABASE_URL is set (e.g. a local `supabase start` instance with
# migrations applied), it is used as-is and no ephemeral cluster is created.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_DIR/supabase/migrations"
SHIM="$REPO_DIR/supabase/tests/supabase-shim.sql"

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  export DATABASE_URL="$TEST_DATABASE_URL"
  exec "$@"
fi

PG_BIN="$(pg_config --bindir 2>/dev/null || true)"
if [[ -z "$PG_BIN" || ! -x "$PG_BIN/initdb" ]]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [[ -z "$PG_BIN" || ! -x "$PG_BIN/initdb" ]]; then
  echo "PostgreSQL server binaries (initdb) not found; install PostgreSQL >= 15 or set TEST_DATABASE_URL." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ai-tutor-testdb.XXXXXX")"
PORT="${TEST_DB_PORT:-54329}"

run_pg() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

cleanup() {
  run_pg "$PG_BIN/pg_ctl" -D "$WORK_DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [[ "$(id -u)" == "0" ]]; then
  chown postgres "$WORK_DIR"
fi

run_pg "$PG_BIN/initdb" -D "$WORK_DIR/data" -U postgres -A trust --no-sync -E UTF8 >/dev/null
run_pg "$PG_BIN/pg_ctl" -D "$WORK_DIR/data" -l "$WORK_DIR/pg.log" -w \
  -o "-k $WORK_DIR -p $PORT -c listen_addresses='' -c fsync=off" start >/dev/null

PSQL=("$PG_BIN/psql" -h "$WORK_DIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database ai_tutor_test"
"${PSQL[@]}" -d ai_tutor_test -f "$SHIM"
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  "${PSQL[@]}" -d ai_tutor_test -f "$f"
done
# Migrations that promise to be re-runnable (Alex applies them by hand in the
# SQL Editor) are applied a second time to prove it.
for f in $(grep -l "Safe to re-run" "$MIGRATIONS_DIR"/*.sql | sort); do
  "${PSQL[@]}" -d ai_tutor_test -f "$f" >/dev/null
done

export DATABASE_URL="postgresql://postgres@localhost/ai_tutor_test?host=$WORK_DIR&port=$PORT"
"$@"
