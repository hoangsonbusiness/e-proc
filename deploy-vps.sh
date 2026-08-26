#!/usr/bin/env bash
set -Eeuo pipefail

# One-file bootstrap for an ephemeral Ubuntu VPS.
# Application source is cloned into APP_DIR and is never modified.
# Runtime Docker/Caddy/Compose files are generated in RUNTIME_DIR.

INSTALL_ROOT="${INSTALL_ROOT:-/opt/e-proc}"
APP_DIR="${INSTALL_ROOT}/app"
RUNTIME_DIR="${INSTALL_ROOT}/runtime"
BACKUP_DIR="${INSTALL_ROOT}/backups"
GIT_REF="${GIT_REF:-main}"
SSH_PORT="${SSH_PORT:-22}"
ADMIN_USERNAME="admin"
ADMIN_BOOTSTRAP_PASSWORD="admin321"

log() { printf '\n\033[1;34m[e-proc]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[e-proc][WARN]\033[0m %s\n' "$*" >&2; }
die() { printf '\n\033[1;31m[e-proc][ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "Run as root: sudo bash deploy-vps.sh"
  [[ -r /etc/os-release ]] || die "Unsupported system: /etc/os-release not found"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "This script currently supports Ubuntu only"
}

prompt_required() {
  local name="$1" prompt="$2" secret="${3:-false}" current="${!name:-}"
  if [[ -z "$current" ]]; then
    if [[ "$secret" == "true" ]]; then
      read -r -s -p "$prompt: " current
      printf '\n'
    else
      read -r -p "$prompt: " current
    fi
  fi
  [[ -n "$current" ]] || die "$name is required"
  printf -v "$name" '%s' "$current"
  export "$name"
}

install_base_packages() {
  log "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git jq openssl ufw dnsutils
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker and Compose are already installed"
    systemctl enable --now docker
    return
  fi

  log "Installing Docker Engine and Docker Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  # shellcheck disable=SC1091
  . /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$VERSION_CODENAME" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

configure_firewall() {
  log "Configuring UFW for SSH, HTTP and HTTPS"
  ufw allow "${SSH_PORT}/tcp"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
}

collect_configuration() {
  prompt_required REPO_URL "Git repository URL"
  prompt_required APP_DOMAIN "Application domain, for example exam.example.com"
  prompt_required DATABASE_URL "Supabase PostgreSQL URL (prefer Session Pooler port 5432 on IPv4 VPS)" true

  APP_DOMAIN="${APP_DOMAIN#http://}"
  APP_DOMAIN="${APP_DOMAIN#https://}"
  APP_DOMAIN="${APP_DOMAIN%%/*}"
  [[ "$APP_DOMAIN" == *.* ]] || die "APP_DOMAIN must be a real DNS hostname"
  [[ "$DATABASE_URL" == postgres://* || "$DATABASE_URL" == postgresql://* ]] \
    || die "DATABASE_URL must start with postgres:// or postgresql://"
}

clone_or_update_app() {
  log "Preparing a clean application checkout at ${APP_DIR}"
  mkdir -p "$INSTALL_ROOT" "$RUNTIME_DIR" "$BACKUP_DIR"

  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --all --tags --prune
  else
    [[ ! -e "$APP_DIR" ]] || die "$APP_DIR exists but is not a Git checkout"
    git clone "$REPO_URL" "$APP_DIR"
  fi

  local deploy_ref="$GIT_REF"
  if git -C "$APP_DIR" rev-parse --verify --quiet "origin/${GIT_REF}^{commit}" >/dev/null; then
    deploy_ref="origin/${GIT_REF}"
  fi
  git -C "$APP_DIR" checkout --detach "$deploy_ref"
  git -C "$APP_DIR" reset --hard "$deploy_ref"
  git -C "$APP_DIR" clean -ffd
  log "Deploying commit $(git -C "$APP_DIR" rev-parse HEAD)"
}

generate_secrets() {
  JWT_SECRET="${JWT_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
  SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
}

write_runtime_files() {
  log "Generating runtime files outside the application checkout"

  cat > "${INSTALL_ROOT}/.dockerignore" <<'EOF'
app/.git
app/.github
app/.claude
app/.codex
app/.agents
app/.vercel
app/node_modules
app/client/node_modules
app/dist
app/client/dist
app/public/assets
app/data
app/.env
app/.env.*
app/*.log
runtime/.env
backups
EOF

  cat > "${RUNTIME_DIR}/Dockerfile" <<'EOF'
FROM node:22-bookworm AS build
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/client/package.json app/client/package-lock.json ./client/
RUN npm ci --prefix client
COPY app/ ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS webapp
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build /build/app/package.json /build/app/package-lock.json ./
COPY --from=build /build/app/node_modules ./node_modules
COPY --from=build /build/app/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/server/server.js"]

FROM caddy:2-alpine AS proxy
COPY runtime/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /build/app/client/dist /srv
EOF

  cat > "${RUNTIME_DIR}/Caddyfile" <<'EOF'
{$APP_DOMAIN} {
	encode zstd gzip

	header {
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()"
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' https:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
	}

	@api path /api /api/*
	handle @api {
		reverse_proxy webapp:3001
	}

	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"

	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}

	log {
		output stdout
		format console
	}
}
EOF

  cat > "${RUNTIME_DIR}/compose.yml" <<'EOF'
name: e-proc
services:
  webapp:
    build:
      context: ..
      dockerfile: runtime/Dockerfile
      target: webapp
    image: e-proc-webapp:local
    restart: unless-stopped
    env_file: [.env]
    expose: ["3001"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 30s
    security_opt: ["no-new-privileges:true"]
    logging:
      driver: json-file
      options: {max-size: "10m", max-file: "5"}

  proxy:
    build:
      context: ..
      dockerfile: runtime/Dockerfile
      target: proxy
    image: e-proc-proxy:local
    restart: unless-stopped
    depends_on:
      webapp:
        condition: service_healthy
    environment:
      APP_DOMAIN: ${APP_DOMAIN}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
    security_opt: ["no-new-privileges:true"]
    logging:
      driver: json-file
      options: {max-size: "10m", max-file: "5"}

volumes:
  caddy_data:
  caddy_config:
EOF

  umask 077
  {
    printf 'APP_DOMAIN=%s\n' "$APP_DOMAIN"
    printf 'NODE_ENV=production\nPORT=3001\n'
    printf 'DATABASE_URL=%s\n' "$DATABASE_URL"
    printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
    printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
    printf 'ALLOWED_ORIGINS=https://%s\n' "$APP_DOMAIN"
    printf 'DB_POOL_MIN=1\nDB_POOL_MAX=5\nSTATEMENT_TIMEOUT=30s\n'
    printf 'ANSWER_FLUSH_INTERVAL=5000\n'
    printf 'AWS_ACCESS_KEY_ID=%s\n' "${AWS_ACCESS_KEY_ID:-}"
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "${AWS_SECRET_ACCESS_KEY:-}"
    printf 'AWS_REGION=%s\n' "${AWS_REGION:-}"
    printf 'S3_RECORDINGS_BUCKET=%s\n' "${S3_RECORDINGS_BUCKET:-}"
  } > "${RUNTIME_DIR}/.env"
  chmod 600 "${RUNTIME_DIR}/.env"
}

update_cloudflare_dns() {
  PUBLIC_IP="$(curl -4fsS --retry 3 https://api.ipify.org)"
  [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Cannot detect VPS public IPv4"

  if [[ -z "${CF_API_TOKEN:-}" || -z "${CF_ZONE_ID:-}" ]]; then
    warn "Cloudflare credentials not supplied. Ensure ${APP_DOMAIN} points to ${PUBLIC_IP}."
    return
  fi

  log "Updating Cloudflare DNS ${APP_DOMAIN} -> ${PUBLIC_IP} (DNS only)"
  local api="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"
  local auth=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")
  local result record_id payload
  result="$(curl -fsS "${auth[@]}" "${api}?type=A&name=${APP_DOMAIN}")"
  [[ "$(jq -r '.success' <<<"$result")" == "true" ]] || die "Cloudflare lookup failed"
  record_id="$(jq -r '.result[0].id // empty' <<<"$result")"
  payload="$(jq -cn --arg name "$APP_DOMAIN" --arg ip "$PUBLIC_IP" '{type:"A",name:$name,content:$ip,ttl:300,proxied:false}')"

  if [[ -n "$record_id" ]]; then
    result="$(curl -fsS -X PUT "${auth[@]}" --data "$payload" "${api}/${record_id}")"
  else
    result="$(curl -fsS -X POST "${auth[@]}" --data "$payload" "$api")"
  fi
  [[ "$(jq -r '.success' <<<"$result")" == "true" ]] || die "Cloudflare DNS update failed"
}

compose() {
  docker compose --env-file "${RUNTIME_DIR}/.env" -f "${RUNTIME_DIR}/compose.yml" "$@"
}

db_psql() {
  docker run --rm -i \
    -e DATABASE_URL="$DATABASE_URL" \
    postgres:16-alpine \
    sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"' _ "$@"
}

initialize_schema_and_migrations() {
  log "Initializing base schema through the existing application DB layer"
  compose run --rm --no-deps -e ALLOW_RUNTIME_SCHEMA_BOOTSTRAP=true --entrypoint node webapp -e \
    "import('./dist/server/db/postgres.js').then(m=>m.dbReady).catch(e=>{console.error('[bootstrap]',e.message);process.exit(0)})"

  log "Applying repository migrations that have not been recorded yet"
  db_psql -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  local migration migration_name applied
  while IFS= read -r migration; do
    migration_name="$(basename "$migration")"
    [[ "$migration_name" =~ ^[0-9A-Za-z._-]+$ ]] || die "Unsafe migration filename: $migration_name"
    applied="$(db_psql -tAc "SELECT 1 FROM public.schema_migrations WHERE name = '$migration_name'" | tr -d '[:space:]')"
    if [[ "$applied" == "1" ]]; then
      log "Migration already applied: $migration_name"
      continue
    fi
    log "Migration: $migration_name"
    docker run --rm \
      -e DATABASE_URL="$DATABASE_URL" \
      -v "${APP_DIR}/migrations:/migrations:ro" \
      postgres:16-alpine \
      sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$1"' _ "/migrations/$migration_name"
    db_psql -c "INSERT INTO public.schema_migrations (name) VALUES ('$migration_name') ON CONFLICT (name) DO NOTHING"
  done < <(find "${APP_DIR}/migrations" -maxdepth 1 -type f -name '*.sql' | sort)
}

ensure_admin_account() {
  log "Ensuring application account ${ADMIN_USERNAME} exists with role admin"
  local hash sql
  hash="$(compose run --rm --no-deps --entrypoint node webapp -e \
    "const b=require('bcryptjs');b.hash('${ADMIN_BOOTSTRAP_PASSWORD}',10).then(console.log)" | tail -n 1)"
  [[ "$hash" == \$2* ]] || die "Could not generate bcrypt password hash"

  sql="INSERT INTO public.admin_users (username,password_hash,role)
       VALUES ('${ADMIN_USERNAME}','${hash}','admin')
       ON CONFLICT (username) DO UPDATE
       SET password_hash=EXCLUDED.password_hash,
           role='admin',
           updated_at=CURRENT_TIMESTAMP;"
  printf '%s\n' "$sql" | db_psql
}

import_question_bank_if_requested() {
  local current_count
  current_count="$(printf '%s\n' 'SELECT COUNT(*) FROM public.question_bank;' | db_psql -At | tr -d '[:space:]')"
  log "Current question_bank row count: ${current_count:-unknown}"

  if [[ -z "${QUESTION_BANK_CSV_URL:-}" ]]; then
    if [[ ! "${current_count:-}" =~ ^[0-9]+$ || "$current_count" -eq 0 ]]; then
      die "question_bank is empty. Re-run with QUESTION_BANK_CSV_URL set to a downloadable UTF-8 CSV URL."
    else
      log "Supabase already contains question data; CSV import skipped"
    fi
    return
  fi

  log "Downloading and upserting question bank CSV"
  curl -fL --retry 3 "$QUESTION_BANK_CSV_URL" -o "${RUNTIME_DIR}/question_bank_rows.csv"

  cat > "${RUNTIME_DIR}/import-question-bank.sql" <<'EOF'
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE question_bank_import (LIKE public.question_bank INCLUDING DEFAULTS);
\copy question_bank_import (id,type,level,module,question_sample,rubric_must_have,rubric_nice_to_have,rubric_optional,created_at,updated_at,options,correct_answers,score,uploaded_by) FROM '/import/question_bank_rows.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8', NULL '')
DO $$
DECLARE total_rows integer; unique_ids integer;
BEGIN
  SELECT COUNT(*), COUNT(DISTINCT id) INTO total_rows, unique_ids FROM question_bank_import;
  IF total_rows <> 599 OR unique_ids <> 599 THEN
    RAISE EXCEPTION 'Expected 599 rows and IDs, got rows=% ids=%', total_rows, unique_ids;
  END IF;
  IF EXISTS (SELECT 1 FROM question_bank_import WHERE type NOT IN ('Coding','Conceptual','Fill-in','Debug','SingleChoice','MultipleChoice') OR level NOT IN ('Easy','Medium','Hard') OR id IS NULL OR module IS NULL OR question_sample IS NULL) THEN
    RAISE EXCEPTION 'CSV contains invalid required values';
  END IF;
END $$;
INSERT INTO public.question_bank (id,type,level,module,question_sample,rubric_must_have,rubric_nice_to_have,rubric_optional,created_at,updated_at,options,correct_answers,score,uploaded_by)
SELECT id,type,level,module,question_sample,rubric_must_have,rubric_nice_to_have,rubric_optional,created_at,updated_at,options,correct_answers,score,uploaded_by FROM question_bank_import
ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type,level=EXCLUDED.level,module=EXCLUDED.module,question_sample=EXCLUDED.question_sample,rubric_must_have=EXCLUDED.rubric_must_have,rubric_nice_to_have=EXCLUDED.rubric_nice_to_have,rubric_optional=EXCLUDED.rubric_optional,updated_at=EXCLUDED.updated_at,options=EXCLUDED.options,correct_answers=EXCLUDED.correct_answers,score=EXCLUDED.score,uploaded_by=COALESCE(EXCLUDED.uploaded_by,public.question_bank.uploaded_by);
COMMIT;
SELECT COUNT(*) AS imported_ids FROM public.question_bank WHERE id IN (SELECT id FROM question_bank_import);
EOF

  docker run --rm \
    -e DATABASE_URL="$DATABASE_URL" \
    -v "${RUNTIME_DIR}:/import:ro" \
    postgres:16-alpine \
    sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /import/import-question-bank.sql'
}

build_and_start() {
  log "Validating Compose configuration"
  compose config --quiet

  log "Building application and proxy images"
  compose build --pull

  initialize_schema_and_migrations
  ensure_admin_account
  import_question_bank_if_requested

  log "Starting webapp and HTTPS proxy"
  compose up -d --remove-orphans
}

wait_for_health() {
  log "Waiting for backend readiness"
  local attempt
  for attempt in $(seq 1 30); do
    if compose exec -T webapp node -e \
      "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      compose ps
      log "Deployment is healthy: https://${APP_DOMAIN}"
      printf '\nAdmin bootstrap account: %s / %s\n' "$ADMIN_USERNAME" "$ADMIN_BOOTSTRAP_PASSWORD"
      printf 'Change this password after the first login.\n'
      printf '\nIf this VPS is only stopped (not terminated), Docker restarts the services automatically on boot.\n'
      printf 'If it is terminated, create a new VPS and run this same script again; Supabase data remains intact.\n'
      return
    fi
    sleep 5
  done

  compose logs --tail=200 webapp proxy || true
  die "Deployment did not become healthy"
}

main() {
  require_root
  install_base_packages
  install_docker
  configure_firewall
  collect_configuration
  generate_secrets
  clone_or_update_app
  write_runtime_files
  update_cloudflare_dns
  build_and_start
  wait_for_health
}

main "$@"
