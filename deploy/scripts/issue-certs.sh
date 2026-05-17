#!/usr/bin/env bash
###
# issue-certs.sh
# One-off issuance of Let's Encrypt certs for erp/mes/api.dhivio.com using
# certbot's webroot plugin. Re-run is a no-op (existing certs are kept).
#
# Pre-req: DNS A/AAAA records already point to this VPS.
###
set -euo pipefail
ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
EMAIL="${LETSENCRYPT_EMAIL:-admin@dhivio.com}"
DOMAINS=(erp.dhivio.com mes.dhivio.com api.dhivio.com)

# Make sure nginx is up so the ACME HTTP-01 challenge can be served.
docker compose --env-file "$ROOT/.env" -f "$ROOT/compose.proxy.yml" up -d nginx

for D in "${DOMAINS[@]}"; do
  if docker run --rm -v dhivio-proxy_certbot-etc:/etc/letsencrypt certbot/certbot \
       certificates 2>/dev/null | grep -q "Domains: $D"; then
    echo "✓ $D already has a cert — skipping"
    continue
  fi
  echo "▶ issuing cert for $D"
  docker run --rm \
    -v dhivio-proxy_certbot-etc:/etc/letsencrypt \
    -v dhivio-proxy_certbot-www:/var/www/certbot \
    certbot/certbot certonly \
      --webroot -w /var/www/certbot \
      --non-interactive --agree-tos \
      -m "$EMAIL" \
      -d "$D"
done

docker exec dhivio-nginx nginx -s reload
echo "✓ certs issued; nginx reloaded"
