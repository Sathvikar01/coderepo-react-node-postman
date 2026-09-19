#!/bin/bash
set -e

MODE="${1:-}"

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[1;33m[WARN]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

setup_env() {
    for file in .env frontend/.env backend/.env; do
        example="${file}.example"
        if [ -f "$example" ] && [ ! -f "$file" ]; then
            cp "$example" "$file"
            log_info "Created $file"
        fi
    done
}

# Generate local secrets before configuration validation. Values are written once,
# preserved across restarts, and never printed or committed.
generate_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 32 | tr -d '\n=+/' | cut -c1-48
    else
        head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-48
    fi
}

ensure_secret() {
    local file="$1" key="$2"
    if grep -q "^${key}=" "$file"; then
        local current
        current="$(grep "^${key}=" "$file" | head -n 1 | cut -d= -f2-)"
        if [ -n "$current" ] && [ "$current" != "replace-me" ]; then
            return
        fi
        local generated
        generated="$(generate_secret)"
        sed -i.bak "s|^${key}=.*|${key}=${generated}|" "$file" && rm -f "${file}.bak"
        log_info "Generated ${key} in ${file}"
    fi
}

configure_secrets() {
    [ -f backend/.env ] || return
    ensure_secret backend/.env "JWT_SECRET"
    ensure_secret backend/.env "EXECUTION_FINGERPRINT_KEY"
    ensure_secret backend/.env "DEMO_LOCAL_TOKEN"
    ensure_secret backend/.env "DEMO_STAGING_TOKEN"
    if grep -q "^SERVER_SECRET_ALIASES_JSON=$" backend/.env; then
        local aliases='[{"alias":"local_token","env":"DEMO_LOCAL_TOKEN","profileIds":[]},{"alias":"staging_token","env":"DEMO_STAGING_TOKEN","profileIds":[]}]'
        sed -i.bak "s|^SERVER_SECRET_ALIASES_JSON=.*|SERVER_SECRET_ALIASES_JSON=${aliases}|" backend/.env && rm -f backend/.env.bak
        log_info "Registered demo secret aliases in backend/.env"
    fi
}

MONGO_HOST="127.0.0.1"
MONGO_PORT="27017"

mongo_is_reachable() {
    (exec 3<>"/dev/tcp/${MONGO_HOST}/${MONGO_PORT}") >/dev/null 2>&1
}

check_mongo() {
    if mongo_is_reachable; then
        log_info "MongoDB is already reachable on ${MONGO_PORT}"
        return
    fi
    log_warn "MongoDB is not reachable; starting it"
    if [ -f /etc/mongod.conf ]; then
        mongod --config /etc/mongod.conf --fork >/dev/null 2>&1 || true
    else
        mkdir -p .mongodb
        mongod --dbpath .mongodb --bind_ip "$MONGO_HOST" --port "$MONGO_PORT" --fork --logpath .mongodb/mongod.log >/dev/null 2>&1 || true
    fi
    mongo_is_reachable || {
        log_error "MongoDB is required on ${MONGO_HOST}:${MONGO_PORT}. Start it, then run this again."
        exit 1
    }
}

seed_database() {
    log_info "Seeding Request Desk database"
    bun run seed
}

setup_env
configure_secrets
check_mongo

case "$MODE" in
    --start|--seed|"") seed_database ;;
    *) log_error "Unknown setup mode: $MODE"; exit 1 ;;
esac

log_info "Request Desk setup complete"
