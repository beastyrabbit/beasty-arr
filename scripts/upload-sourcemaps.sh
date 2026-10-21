#!/usr/bin/env bash
set -euo pipefail
: "${GLITCHTIP_AUTH_TOKEN:?Inject the upload token with Infisical}"
: "${SENTRY_RELEASE:?Set the release to upload}"
export SENTRY_ORG="${SENTRY_ORG:-beasty-rabbit}"
export SENTRY_PROJECT="${SENTRY_PROJECT:-beasty-arr}"
# The proxy supplies the real token. The CLI only needs a nonempty auth value.
export SENTRY_AUTH_TOKEN=upload-proxy
artifacts=$(realpath "${1:-dist/sourcemaps}")
test -d "$artifacts/web"
ready=$(mktemp)
proxy_pid=
cleanup() {
  if [ -n "$proxy_pid" ]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  rm -f "$ready"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$(dirname "$0")/glitchtip-upload-proxy.mjs" > "$ready" &
proxy_pid=$!
for ((attempt=0; attempt<100; attempt++)); do
  kill -0 "$proxy_pid"
  if [ -s "$ready" ]; then break; fi
  sleep 0.1
done
test -s "$ready"
read -r SENTRY_URL < "$ready"
export SENTRY_URL
cli() {
  docker run --rm --network host --env SENTRY_URL --env SENTRY_ORG --env SENTRY_PROJECT \
    --env SENTRY_AUTH_TOKEN -v "$artifacts:/artifacts:ro" \
    getsentry/sentry-cli:2.58.5@sha256:cb8c539da5a608b6afc185ccdf4985d6f625432c0135c731364c1c39aaa62dcf "$@"
}
cli releases new "$SENTRY_RELEASE"
# GlitchTip 6.2.6 always returns "created" from artifactbundle/assemble, even after
# processing. --wait would poll until timeout. HTTP/assembly errors still fail.
cli sourcemaps upload --strict --validate --release "$SENTRY_RELEASE" --url-prefix '~/' /artifacts/web
cli releases finalize "$SENTRY_RELEASE"
