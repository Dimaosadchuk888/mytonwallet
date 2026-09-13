#!/usr/bin/env bash

# Despite its historical filename, this deploys only to the Hostinger VPS.
# The retired Hostinger shared-hosting API is intentionally not used.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${HOSTINGER_VPS_HOST:?Set HOSTINGER_VPS_HOST}"
: "${HOSTINGER_VPS_USER:?Set HOSTINGER_VPS_USER}"

VPS_PORT="${HOSTINGER_VPS_PORT:-22}"
VPS_ROOT="${HOSTINGER_VPS_ROOT:-/opt/mytonwallet-frontend}"
LIVE_URL="${LIVE_URL:-https://mytonwallet.shop}"
CORS_CHECK_URL="${CORS_CHECK_URL:-${BRILLIANT_API_BASE_URL:-https://api.mywallet.io}/referrer/get}"
DEPLOY_COMMIT="${DEPLOY_COMMIT:-$(git rev-parse HEAD)}"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-${DEPLOY_COMMIT:0:12}"
REMOTE_RELEASE="$VPS_ROOT/releases/$RELEASE_ID"
STAGING_DIR="$(mktemp -d)"
ARCHIVE_PATH="$STAGING_DIR/source.tar.gz"
CI_DIST_ARCHIVE_PATH="$STAGING_DIR/ci-dist.tar.gz"
ENV_PATH="$STAGING_DIR/build.env"
KEY_PATH="$STAGING_DIR/deploy_key"
KNOWN_HOSTS_PATH="$ROOT_DIR/deploy/hostinger_known_hosts"
SSH_TARGET="$HOSTINGER_VPS_USER@$HOSTINGER_VPS_HOST"

if [ -z "$CORS_CHECK_URL" ]; then
  echo "Set CORS_CHECK_URL or BRILLIANT_API_BASE_URL; deploys without a backend CORS check are not allowed."
  exit 1
fi

test -s "$KNOWN_HOSTS_PATH" || {
  echo "Pinned Hostinger VPS host key is missing."
  exit 1
}
HOST_KEY_OPTIONS=(
  -o HostKeyAlias=hostinger-production
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS_PATH"
)

SSH_OPTIONS=(-p "$VPS_PORT" -o BatchMode=yes "${HOST_KEY_OPTIONS[@]}")
SCP_OPTIONS=(-P "$VPS_PORT" -o BatchMode=yes "${HOST_KEY_OPTIONS[@]}")

if [ -n "${HOSTINGER_VPS_SSH_PRIVATE_KEY:-}" ]; then
  printf '%s\n' "$HOSTINGER_VPS_SSH_PRIVATE_KEY" > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
  SSH_OPTIONS+=(-i "$KEY_PATH")
  SCP_OPTIONS+=(-i "$KEY_PATH")
elif [ -n "${HOSTINGER_VPS_PASSWORD:-}" ]; then
  command -v sshpass >/dev/null || {
    echo "sshpass is required when HOSTINGER_VPS_PASSWORD is used."
    exit 1
  }
  export SSHPASS="$HOSTINGER_VPS_PASSWORD"
  SSH_OPTIONS=(-p "$VPS_PORT" "${HOST_KEY_OPTIONS[@]}")
  SCP_OPTIONS=(-P "$VPS_PORT" "${HOST_KEY_OPTIONS[@]}")
  SSH_COMMAND=(sshpass -e ssh)
  SCP_COMMAND=(sshpass -e scp)
else
  echo "Set HOSTINGER_VPS_SSH_PRIVATE_KEY or HOSTINGER_VPS_PASSWORD."
  exit 1
fi

SSH_COMMAND=("${SSH_COMMAND[@]:-ssh}")
SCP_COMMAND=("${SCP_COMMAND[@]:-scp}")

cleanup() {
  rm -rf "$STAGING_DIR"
  unset SSHPASS
}
trap cleanup EXIT

printf 'DEPLOY_COMMIT=%q\n' "$DEPLOY_COMMIT" > "$ENV_PATH"
printf 'APP_COMMIT_HASH=%q\n' "$DEPLOY_COMMIT" >> "$ENV_PATH"
for name in STAKING_POOLS PUBLISH_REPO BRILLIANT_API_BASE_URL PROXY_API_BASE_URL TONCENTER_MAINNET_URL TONAPIIO_MAINNET_URL SWAP_FEE_ADDRESS DIESEL_ADDRESS AGENT_API_URL; do
  printf '%s=%q\n' "$name" "${!name:-}" >> "$ENV_PATH"
done

echo "Packing source for release $RELEASE_ID..."
test -s dist/index.html || {
  echo "The verified CI dist artifact is missing."
  exit 1
}
tar \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='./.agents' \
  --exclude='./.local' \
  -czf "$ARCHIVE_PATH" .
tar -czf "$CI_DIST_ARCHIVE_PATH" -C dist .

"${SSH_COMMAND[@]}" "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  "mkdir -p '$REMOTE_RELEASE'"
"${SCP_COMMAND[@]}" "${SCP_OPTIONS[@]}" "$ARCHIVE_PATH" "$CI_DIST_ARCHIVE_PATH" "$ENV_PATH" \
  "$SSH_TARGET:$REMOTE_RELEASE/"

echo "Building and activating $REMOTE_RELEASE..."
"${SSH_COMMAND[@]}" "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  bash -s -- "$REMOTE_RELEASE" "$VPS_ROOT" "$LIVE_URL" "$CORS_CHECK_URL" <<'REMOTE'
set -euo pipefail
release="$1"
root="$2"
live_url="$3"
cors_check_url="$4"
previous_target=""
if [ -e "$root/current" ] || [ -L "$root/current" ]; then
  candidate="$(readlink -f "$root/current" 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -d "$candidate" ]; then
    previous_target="$candidate"
  fi
fi
activated=0
release_name="$(basename "$release")"
next_link="$root/.current-$release_name-next"
rollback_link="$root/.current-$release_name-rollback"

reload_nginx() {
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
    return
  fi

  echo "Host Nginx is inactive; starting nginx.service."
  systemctl start nginx
  systemctl is-active --quiet nginx
}

ensure_telegram_frame_policy() {
  frontend_conf="/etc/nginx/conf.d/mytonwallet-frontend.conf"
  if [ ! -f "$frontend_conf" ]; then
    echo "Expected MyTonWallet frontend Nginx config is missing: $frontend_conf"
    return 1
  fi

  if ! grep -q "frame-ancestors.*web.telegram.org" "$frontend_conf"; then
    backup="$frontend_conf.bak.telegram-frame-$(date -u +%Y%m%d%H%M%S)"
    cp -a "$frontend_conf" "$backup"
    sed -i "/^[[:space:]]*index index.html;$/a\\    add_header Content-Security-Policy \"frame-ancestors 'self' https://stand.ton-connect.io https://web.telegram.org\" always;" "$frontend_conf"
    echo "Added Telegram frame policy to $frontend_conf (backup: $backup)."
  fi
}

rollback() {
  status=$?
  rm -f "$next_link" "$rollback_link"
  if [ "$status" -ne 0 ] && [ "$activated" -eq 1 ]; then
    if [ -n "$previous_target" ]; then
      echo "Release validation failed; restoring $previous_target."
      ln -s "$previous_target" "$rollback_link"
      mv -Tf "$rollback_link" "$root/current"
      nginx -t && reload_nginx
    else
      echo "Initial release validation failed; removing the failed current symlink."
      rm -f "$root/current"
    fi
  fi
  exit "$status"
}
trap rollback EXIT

tar -xzf "$release/source.tar.gz" -C "$release"
rm "$release/source.tar.gz"
mkdir "$release/ci-dist"
tar -xzf "$release/ci-dist.tar.gz" -C "$release/ci-dist"
rm "$release/ci-dist.tar.gz"
set -a
source "$release/build.env"
set +a
rm "$release/build.env"

cd "$release"
lock_hash="$(sha256sum package-lock.json | awk '{print $1}')"
dependency_release=""
while IFS= read -r candidate; do
  if [ -d "$candidate/node_modules" ] \
    && [ -f "$candidate/package-lock.json" ] \
    && [ "$(sha256sum "$candidate/package-lock.json" | awk '{print $1}')" = "$lock_hash" ]; then
    dependency_release="$candidate"
    break
  fi
done < <(find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr | cut -d' ' -f2-)

if [ -n "$dependency_release" ]; then
  echo "Reusing lockfile-matched dependencies from $dependency_release."
  cp -a "$dependency_release/node_modules" "$release/node_modules"
else
  echo "No lockfile-matched dependency tree exists; running a clean install."
  npm ci
fi
git config --global --add safe.directory "$release"

APP_COMMIT_HASH="$DEPLOY_COMMIT" npm run build:production
test -s dist/index.html
test "$(cat dist/version.txt)" = "$(node -p "require('./package.json').version")"

# Runtime assets must exactly match the artifact built and checked by CI.
# Build metadata and Statoscope reports contain timestamps and are validated separately.
find ci-dist -type f \
  ! -name '*.map' \
  ! -name build.txt \
  ! -name statoscope-build-statistics.json \
  ! -name statoscope-report.html \
  -printf '%P\n' | LC_ALL=C sort > /tmp/ci-dist-files
find dist -type f \
  ! -name '*.map' \
  ! -name build.txt \
  ! -name statoscope-build-statistics.json \
  ! -name statoscope-report.html \
  -printf '%P\n' | LC_ALL=C sort > /tmp/vps-dist-files
diff -u /tmp/ci-dist-files /tmp/vps-dist-files
while IFS= read -r file; do
  test "$(sha256sum "ci-dist/$file" | awk '{print $1}')" \
    = "$(sha256sum "dist/$file" | awk '{print $1}')"
done < /tmp/ci-dist-files
grep -qx "version=$(node -p "require('./package.json').version")" dist/build.txt
grep -qx "commit=$DEPLOY_COMMIT" dist/build.txt
grep -qx 'env=production' dist/build.txt
rm -rf ci-dist /tmp/ci-dist-files /tmp/vps-dist-files

bundle="$(grep -oE 'src="[^"]*main\.[a-f0-9]+\.js(\?[^"]*)?"' dist/index.html \
  | sed -E 's/^src="//; s/"$//; s/\?.*$//' | head -1)"
test -n "$bundle"
bundle="${bundle#./}"
bundle="${bundle#/}"
test -s "dist/$bundle"
printf '%s\n' "$bundle" > .release-bundle
sha256sum "dist/$bundle" | awk '{print $1}' > .release-bundle.sha256
printf '%s\n' "$DEPLOY_COMMIT" > .release-commit

# Validate the active Nginx configuration before changing the live symlink.
ensure_telegram_frame_policy
nginx -t
rm -f "$next_link"
ln -s "$release" "$next_link"
mv -Tf "$next_link" "$root/current"
activated=1
nginx -t
reload_nginx

expected_bundle="$(cat .release-bundle)"
expected_hash="$(cat .release-bundle.sha256)"
echo "Checking live bundle $expected_bundle..."
live_hash="$(curl --fail --silent --show-error --location --retry 5 --retry-all-errors \
  --max-time 30 "$live_url/$expected_bundle" | sha256sum | awk '{print $1}')"
if [ "$live_hash" != "$expected_hash" ]; then
  echo "Live bundle hash does not match the new release."
  exit 1
fi

echo "Checking backend CORS for $live_url..."
cors_headers_file="$release/.cors-headers"
cors_status="$(curl --silent --show-error --retry 3 --max-time 30 \
  -D "$cors_headers_file" -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H "Origin: $live_url" \
  -H 'Access-Control-Request-Method: GET' \
  "$cors_check_url")"
if [ "$cors_status" -lt 200 ] || [ "$cors_status" -ge 300 ]; then
  echo "Backend CORS check failed with HTTP $cors_status."
  exit 1
fi
allow_origin="$(tr -d '\r' < "$cors_headers_file" \
  | awk 'BEGIN{IGNORECASE=1} /^access-control-allow-origin:/ {sub(/^[^:]+:[[:space:]]*/, ""); print; exit}')"
rm "$cors_headers_file"
if [ "$allow_origin" != "$live_url" ] && [ "$allow_origin" != "*" ]; then
  echo "Backend CORS check failed: Access-Control-Allow-Origin is '$allow_origin'."
  exit 1
fi

# Retain the current release and four predecessors for immediate rollback.
find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr | tail -n +6 | cut -d' ' -f2- | xargs -r rm -rf --
activated=0
trap - EXIT
REMOTE

echo "Deployed $DEPLOY_COMMIT to $LIVE_URL as $RELEASE_ID."