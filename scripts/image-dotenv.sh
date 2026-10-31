#!/usr/bin/env bash
# Checks that the probe image never loads dotenv files, also not from its healthcheck.
# Usage: bash scripts/image-dotenv.sh <image>
# Each case runs in its own child process so that `set -e` applies inside it.
set -uo pipefail

marker="dotenv-marker-556"
fixture=(-e PULSE_API_URL=http://127.0.0.1:9 -e PULSE_PROBE_TOKEN=dotenv-ci-0123456789abcdef)

case_control() {
  local image="$1" err code=0
  err=$(timeout 30 docker run --rm "${fixture[@]}" -e "PULSE_LOG_LEVEL=$marker" "$image" 2>&1 >/dev/null) || code=$?
  if [ "$code" -ne 2 ]; then
    echo "reason: exit $code, want 2"
    exit 1
  fi
  if ! grep -q PULSE_LOG_LEVEL <<<"$err"; then
    echo "reason: stderr does not name PULSE_LOG_LEVEL"
    exit 1
  fi
}

show_exit() {
  echo "container exit code: $(docker inspect -f '{{.State.ExitCode}}' "$1")"
  docker logs --tail 20 "$1" 2>&1 || true
}

case_dotenv() {
  local name="$1" image="$2" dir="$3"
  local c="${DOTENV_RUN_ID:?}-${name//./}"
  printf 'PULSE_LOG_LEVEL=%s\n' "$marker" >"$dir/dotenv"
  chmod 0644 "$dir/dotenv"
  docker run -d --name "$c" "${fixture[@]}" -v "$dir/dotenv:/app/$name:ro" "$image" >/dev/null
  local -a health
  mapfile -t health < <(docker image inspect --format '{{range .Config.Healthcheck.Test}}{{println .}}{{end}}' "$image")
  [ "${health[0]:-}" = "CMD" ] || { echo "reason: healthcheck is not CMD form"; exit 1; }
  health=("${health[@]:1}")
  local healthy=0
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c")" != "true" ]; then
      show_exit "$c"
      echo "reason: container exited $(docker inspect -f '{{.State.ExitCode}}' "$c")"
      exit 1
    fi
    if docker exec "$c" "${health[@]}" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 0.5
  done
  if [ "$healthy" -ne 1 ]; then
    show_exit "$c"
    echo "reason: healthcheck did not pass within 30 s"
    exit 1
  fi
  docker exec "$c" sh -c "test -r /app/$name && test -s /app/$name" || { echo "reason: /app/$name is not readable"; exit 1; }
  if docker logs "$c" 2>&1 | grep -q "$marker"; then
    echo "reason: logs contain the marker"
    exit 1
  fi
  docker stop -t 10 "$c" >/dev/null
  local code
  code=$(docker inspect -f '{{.State.ExitCode}}' "$c")
  [ "$code" = "0" ] || { echo "reason: exit $code after stop, want 0"; exit 1; }
}

case_image_config() {
  local image="$1"
  docker image inspect "$image" \
    | jq -e '.[0].Config.Cmd == ["bun","--no-env-file","src/main.ts"]' >/dev/null \
    || { echo "reason: Cmd is $(docker image inspect --format '{{json .Config.Cmd}}' "$image")"; exit 1; }
  docker image inspect "$image" \
    | jq -e '.[0].Config.Healthcheck.Test[0:4] == ["CMD","bun","--no-env-file","-e"]' >/dev/null \
    || { echo "reason: healthcheck does not start with bun --no-env-file -e"; exit 1; }
}

if [ "${1:-}" = "--case" ]; then
  set -euo pipefail
  name="$2" image="$3"
  case "$name" in
    control) case_control "$image" ;;
    .env | .env.production | .env.local)
      dir="$4"
      case_dotenv "$name" "$image" "$dir"
      ;;
    image-config) case_image_config "$image" ;;
    *)
      echo "reason: unknown case $name"
      exit 1
      ;;
  esac
  exit 0
fi

image="${1:?usage: image-dotenv.sh <image>}"
dir=$(mktemp -d)
chmod 0755 "$dir"
export DOTENV_RUN_ID="pulse-dotenv-$$-$RANDOM"
cleanup() {
  local id
  for id in $(docker ps -aq --filter "name=^/$DOTENV_RUN_ID-"); do
    docker rm -f "$id" >/dev/null 2>&1 || true
  done
  rm -rf "$dir"
}
trap cleanup EXIT

failed=0
for name in control .env .env.production .env.local image-config; do
  out=$(bash "$0" --case "$name" "$image" "$dir" 2>&1)
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "ok: $name"
  else
    reason=$(grep '^reason: ' <<<"$out" | tail -n 1 | sed 's/^reason: //')
    grep -v '^reason: ' <<<"$out" || true
    echo "FAIL: $name: ${reason:-exit $code}"
    failed=1
  fi
done
exit "$failed"
