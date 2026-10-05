#!/usr/bin/env bash
# Uses only a disposable local PostgreSQL instance, never an app database.
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d /tmp/evm-migrations.XXXXXX)
cleanup() {
  pg_ctl -D "$test_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT
initdb -D "$test_dir/data" --auth=trust --no-locale > "$test_dir/init.log"
# Unix socket only; no TCP listener or access to remote databases.
pg_ctl -D "$test_dir/data" -l "$test_dir/postgres.log" \
  -o "-k $test_dir -p 55439 -c listen_addresses=''" -w start >/dev/null
psql_test=(psql -X -h "$test_dir" -p 55439 -U "$(id -un)" -d postgres -v ON_ERROR_STOP=1)
"${psql_test[@]}" <<'SQL'
create role anon;
create role authenticated;
create role service_role bypassrls;
-- Minimal prerequisite fixture, not a replacement for the production schema.
create table internal_ton_users(telegram_id text primary key);
SQL
"${psql_test[@]}" -f supabase/migrations/005_internal_evm_authorizations.sql
"${psql_test[@]}" -f supabase/migrations/008_admin_telegram_bot_autodebit.sql
"${psql_test[@]}" -f supabase/migrations/008_admin_telegram_bot_autodebit.sql
"${psql_test[@]}" -f tests/sql/admin-bot-migrations.sql
"${psql_test[@]}" -f supabase/migrations/009_internal_evm_permit2_uint160.sql
"${psql_test[@]}" -f supabase/migrations/010_internal_evm_direct_authorization.sql
"${psql_test[@]}" -f supabase/migrations/011_internal_evm_direct_registration.sql
"${psql_test[@]}" -f tests/sql/internal-evm-direct-registration.sql