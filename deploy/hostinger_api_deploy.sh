#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${HOSTINGER_API_TOKEN:?Set HOSTINGER_API_TOKEN in Replit Secrets before deploying}"

BASE_URL="https://developers.hostinger.com"
DOMAIN="${HOSTINGER_DOMAIN:-mytonwallet.shop}"
ARCHIVE_NAME="${HOSTINGER_ARCHIVE_NAME:-mytonwallet-hostinger.zip}"
STAGING_DIR="$(mktemp -d)"
RESPONSE_FILE="$(mktemp)"

cleanup() {
  rm -rf "$STAGING_DIR" "$RESPONSE_FILE"
}
trap cleanup EXIT

echo "Building production site..."
npm run build

mkdir -p "$STAGING_DIR/site"
cp -a dist/. "$STAGING_DIR/site/"

cat > "$STAGING_DIR/site/.htaccess" <<'EOF'
RewriteEngine On

RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]

RewriteRule ^ index.html [L]
EOF

(
  cd "$STAGING_DIR/site"
  zip -qr "$STAGING_DIR/$ARCHIVE_NAME" .
)

ARCHIVE_PATH="$STAGING_DIR/$ARCHIVE_NAME"
ARCHIVE_SIZE="$(stat -c '%s' "$ARCHIVE_PATH")"

echo "Finding Hostinger website for $DOMAIN..."
WEBSITES_JSON="$(curl -sS --max-time 30 \
  -H "Authorization: Bearer ${HOSTINGER_API_TOKEN}" \
  -H 'Accept: application/json' \
  "$BASE_URL/api/hosting/v1/websites?domain=$DOMAIN")"

USERNAME="$(printf '%s' "$WEBSITES_JSON" | jq -r --arg domain "$DOMAIN" \
  '.data[]? | select(.domain == $domain) | .username // empty' | head -1)"

if [ -z "$USERNAME" ]; then
  echo "No Hostinger website was found for $DOMAIN. Create the website in Hostinger first."
  exit 1
fi

echo "Requesting temporary upload URL..."
UPLOAD_CODE="$(curl -sS --max-time 30 -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$BASE_URL/api/hosting/v1/files/upload-urls" \
  -H "Authorization: Bearer ${HOSTINGER_API_TOKEN}" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  --data "{\"username\":\"$USERNAME\",\"domain\":\"$DOMAIN\"}")"

if [ "$UPLOAD_CODE" -lt 200 ] || [ "$UPLOAD_CODE" -ge 300 ]; then
  echo "Hostinger upload URL request failed with HTTP $UPLOAD_CODE"
  jq -c '{message:(.message // null), errors:(.errors // null)}' "$RESPONSE_FILE" 2>/dev/null || true
  exit 1
fi

UPLOAD_URL="$(jq -r '.url // empty' "$RESPONSE_FILE")"
AUTH_KEY="$(jq -r '.auth_key // empty' "$RESPONSE_FILE")"
REST_AUTH_KEY="$(jq -r '.rest_auth_key // empty' "$RESPONSE_FILE")"

if [ -z "$UPLOAD_URL" ] || [ -z "$AUTH_KEY" ] || [ -z "$REST_AUTH_KEY" ]; then
  echo "Hostinger returned an incomplete upload URL response"
  exit 1
fi

TARGET_URL="${UPLOAD_URL%/}/${ARCHIVE_NAME}?override=true"

echo "Uploading ${ARCHIVE_SIZE} bytes..."
CREATE_CODE="$(curl -sS --max-time 60 -o /dev/null -w '%{http_code}' \
  -X POST "$TARGET_URL" \
  -H "X-Auth: $AUTH_KEY" \
  -H "X-Auth-Rest: $REST_AUTH_KEY" \
  -H 'Tus-Resumable: 1.0.0' \
  -H "Upload-Length: $ARCHIVE_SIZE" \
  -H 'Upload-Offset: 0')"

if [ "$CREATE_CODE" != "201" ]; then
  echo "Hostinger upload initialization failed with HTTP $CREATE_CODE"
  exit 1
fi

PATCH_CODE="$(curl -sS --max-time 180 -o /dev/null -w '%{http_code}' \
  -X PATCH "$TARGET_URL" \
  -H "X-Auth: $AUTH_KEY" \
  -H "X-Auth-Rest: $REST_AUTH_KEY" \
  -H 'Tus-Resumable: 1.0.0' \
  -H 'Content-Type: application/offset+octet-stream' \
  -H 'Upload-Offset: 0' \
  --data-binary "@$ARCHIVE_PATH")"

if [ "$PATCH_CODE" != "204" ]; then
  echo "Hostinger archive upload failed with HTTP $PATCH_CODE"
  exit 1
fi

echo "Deploying archive to $DOMAIN..."
DEPLOY_CODE="$(curl -sS --max-time 120 -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$BASE_URL/api/hosting/v1/accounts/$USERNAME/websites/$DOMAIN/deploy" \
  -H "Authorization: Bearer ${HOSTINGER_API_TOKEN}" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  --data "{\"archive_path\":\"$ARCHIVE_NAME\"}")"

if [ "$DEPLOY_CODE" -lt 200 ] || [ "$DEPLOY_CODE" -ge 300 ]; then
  echo "Hostinger deploy failed with HTTP $DEPLOY_CODE"
  jq -c '{message:(.message // null), errors:(.errors // null)}' "$RESPONSE_FILE" 2>/dev/null || true
  exit 1
fi

echo "Hostinger deploy accepted for https://$DOMAIN"