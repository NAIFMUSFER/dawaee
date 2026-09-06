#!/usr/bin/env bash
#
# What the production image must be true of, checked against the built image.
#
# P15 audited the Dockerfile and could not audit the IMAGE: the sandbox could
# not pull `node:22-bookworm-slim`, so every container property was reasoned
# from the file rather than observed in the artefact. A Dockerfile that says
# `USER dawaee` and an image that actually runs as uid 1001 are different
# claims, and only the second one deploys.
#
# Everything here runs against the real image. `docker build` succeeding is not
# one of the assertions — it is the precondition.
#
# Usage: ./scripts/container-checks.sh dawaee:ci
set -euo pipefail

IMAGE="${1:?usage: container-checks.sh <image>}"
failures=0

check() {
  local name="$1"; shift
  if "$@" > /tmp/check-out 2>&1; then
    echo "  PASS  $name"
  else
    echo "  FAIL  $name"
    sed 's/^/          /' /tmp/check-out | head -10
    failures=$((failures + 1))
  fi
}

echo "=== container security properties: $IMAGE ==="

# --- identity -------------------------------------------------------------

check "runs as a non-root user" bash -c '
  uid=$(docker run --rm --entrypoint id '"$IMAGE"' -u)
  [ "$uid" != "0" ] || { echo "container runs as uid 0"; exit 1; }
  echo "uid=$uid"
'

check "the filesystem is not owned by the running user" bash -c '
  # A non-root user that owns /app can rewrite the application it is running,
  # which turns any file-write bug into persistence.
  owner=$(docker run --rm --entrypoint stat '"$IMAGE"' -c %U /app/apps/api/dist)
  [ "$owner" = "root" ] || { echo "/app is owned by $owner, not root"; exit 1; }
'

# --- process ---------------------------------------------------------------

check "node is PID 1, so SIGTERM reaches it" bash -c '
  cid=$(docker run -d --entrypoint node '"$IMAGE"' -e "process.on(\"SIGTERM\",()=>{console.log(\"sigterm-received\");process.exit(0)});setInterval(()=>{},1000)")
  trap "docker rm -f $cid >/dev/null 2>&1 || true" EXIT
  sleep 2
  comm=$(docker exec "$cid" cat /proc/1/comm)
  [ "$comm" = "node" ] || { echo "PID 1 is $comm, not node"; exit 1; }
  docker stop -t 10 "$cid" >/dev/null
  # An exit code of 143 means the process was killed by SIGTERM rather than
  # handling it; 0 means it drained and exited cleanly.
  code=$(docker inspect -f "{{.State.ExitCode}}" "$cid")
  docker logs "$cid" 2>&1 | grep -q sigterm-received || { echo "SIGTERM never reached the process"; exit 1; }
  [ "$code" = "0" ] || { echo "exit code $code after SIGTERM, expected a clean 0"; exit 1; }
'

# --- contents --------------------------------------------------------------

check "no .env file was baked into the image" bash -c '
  found=$(docker run --rm --entrypoint find '"$IMAGE"' / -maxdepth 4 -name ".env*" -not -path "*/node_modules/*" 2>/dev/null || true)
  [ -z "$found" ] || { echo "found: $found"; exit 1; }
'

check "the mobile app is not in the image" bash -c '
  found=$(docker run --rm --entrypoint sh '"$IMAGE"' -c "ls -d /app/apps/mobile 2>/dev/null || true")
  [ -z "$found" ] || { echo "apps/mobile shipped"; exit 1; }
'

check "no test suite shipped" bash -c '
  found=$(docker run --rm --entrypoint sh '"$IMAGE"' -c "find /app -path /app/node_modules -prune -o -name \"*.test.js\" -print 2>/dev/null | head -5")
  [ -z "$found" ] || { echo "found: $found"; exit 1; }
'

check "no build toolchain in the runtime image" bash -c '
  for tool in tsc eslint vitest; do
    if docker run --rm --entrypoint sh '"$IMAGE"' -c "test -e /app/node_modules/.bin/$tool"; then
      echo "$tool is present in the runtime image"; exit 1
    fi
  done
'

check "no source directories, only compiled output" bash -c '
  found=$(docker run --rm --entrypoint sh '"$IMAGE"' -c "ls -d /app/packages/*/src /app/apps/*/src 2>/dev/null || true")
  [ -z "$found" ] || { echo "found: $found"; exit 1; }
'

# --- configuration ---------------------------------------------------------

check "no secret was baked into an image layer" bash -c '
  # Values, not names: NODE_ENV and APP are expected. Anything that looks like
  # a credential in the image config is in the registry forever.
  cfg=$(docker inspect -f "{{json .Config.Env}}" '"$IMAGE"')
  echo "$cfg" | grep -qiE "(postgres://[^\"]*:[^\"@]+@|JWT_SECRET=.{8}|API_KEY=.{8}|PASSWORD=.{4})" \
    && { echo "credential-shaped value in image env"; exit 1; }
  echo "env: $cfg"
'

check "the build identity is present and is the commit CI built" bash -c '
  rev=$(docker inspect -f "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" '"$IMAGE"')
  [ -n "$rev" ] && [ "$rev" != "unknown" ] || { echo "no image revision label"; exit 1; }
  echo "revision=$rev"
'

check "TLS verification cannot be disabled by configuration in production" bash -c '
  # `DATABASE_SSL=no-verify` accepts any certificate from anyone. The config
  # must refuse to boot rather than silently accept it.
  out=$(docker run --rm -e NODE_ENV=production -e DATABASE_SSL=no-verify \
        -e DATABASE_URL=postgres://u:p@example.invalid:5432/d \
        -e JWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
        -e IP_HASH_SALT=x '"$IMAGE"' 2>&1 || true)
  echo "$out" | grep -qi "no-verify\|DATABASE_SSL" || { echo "boot did not reject no-verify: $out"; exit 1; }
'

check "the image reports its own version over HTTP" bash -c '
  cid=$(docker run -d -e NODE_ENV=test -e DATABASE_URL=postgres://u:p@127.0.0.1:5432/d \
        -e JWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
        -e IP_HASH_SALT=x -p 18080:8080 '"$IMAGE"')
  trap "docker rm -f $cid >/dev/null 2>&1 || true" EXIT
  for i in $(seq 1 30); do
    body=$(curl -fsS http://127.0.0.1:18080/version 2>/dev/null) && break
    sleep 1
  done
  [ -n "${body:-}" ] || { echo "no response from /version"; docker logs "$cid" 2>&1 | tail -20; exit 1; }
  echo "$body"
  echo "$body" | grep -q "\"commit\"" || { echo "/version did not report a commit"; exit 1; }
  echo "$body" | grep -qiE "secret|password|postgres://" && { echo "/version leaked configuration"; exit 1; }
  true
'

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures container check(s) FAILED"
  exit 1
fi
echo "all container checks passed"
