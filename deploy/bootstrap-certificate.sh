#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/.deploy.env"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE (copy deploy/.deploy.env.example first)." >&2
  exit 1
fi

PUBLIC_HOST="$(sed -n 's/^PUBLIC_HOST=//p' "$ENV_FILE" | tail -n 1)"
: "${PUBLIC_HOST:?PUBLIC_HOST is missing from deploy/.deploy.env}"
: "${LETSENCRYPT_EMAIL:?Export LETSENCRYPT_EMAIL before running this command}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose --profile certificate-bootstrap up -d nginx-bootstrap

if printf '%s' "$PUBLIC_HOST" | grep -Eq '^[0-9a-fA-F:.]+$'; then
  compose --profile certificate run --rm --entrypoint certbot certbot \
    certonly \
    --preferred-profile shortlived \
    --webroot \
    --webroot-path /var/www/acme \
    --ip-address "$PUBLIC_HOST" \
    --non-interactive \
    --agree-tos \
    --email "$LETSENCRYPT_EMAIL"
else
  compose --profile certificate run --rm --entrypoint certbot certbot \
    certonly \
    --webroot \
    --webroot-path /var/www/acme \
    --domain "$PUBLIC_HOST" \
    --non-interactive \
    --agree-tos \
    --email "$LETSENCRYPT_EMAIL"
fi

compose --profile certificate-bootstrap stop nginx-bootstrap
echo "Certificate created. Start the current application service and nginx next."
