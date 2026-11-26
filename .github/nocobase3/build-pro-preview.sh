#!/usr/bin/env bash
set -euo pipefail
# Only the source checkout enters the builder. No Actions files, Studio credentials, host mounts or Docker socket.
builder="pro-build-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
registry="$builder-registry"
cleanup() {
  docker rm -fv "$registry" "$builder" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$builder" --workdir /pro node:24-bookworm sleep infinity >/dev/null
docker cp pro/. "$builder:/pro"
docker exec "$builder" git config --global --add safe.directory '*'
docker exec "$builder" corepack enable
# Generate registry rules from the checkout, inside the isolated builder.
docker exec "$builder" node scripts/smoke-registry-config.mjs > "$RUNNER_TEMP/pro-verdaccio.yaml"
chmod 644 "$RUNNER_TEMP/pro-verdaccio.yaml"
docker run -d --name "$registry" --network "container:$builder" \
  -v "$RUNNER_TEMP/pro-verdaccio.yaml:/verdaccio/conf/config.yaml:ro" verdaccio/verdaccio:5 >/dev/null
# Keep private build output out of public Actions logs.
docker exec -e CI=true "$builder" bash -euc '
  pnpm install --frozen-lockfile
  pnpm unreleased:prepare --port 4873 --external-registry
  pnpm preview:build /preview
' > "$RUNNER_TEMP/pro-build.log" 2>&1
archive=/preview/pro-preview/storage/exports/dist.tar.gz
docker exec "$builder" cat "$archive" > "$RUNNER_TEMP/pro-dist.tar.gz"
bytes="$(stat -c %s "$RUNNER_TEMP/pro-dist.tar.gz")"
(( bytes > 0 && bytes <= 268435456 )) || { echo "::error::Archive size $bytes exceeds the Studio upload limit or is empty"; exit 1; }
tar -tzf "$RUNNER_TEMP/pro-dist.tar.gz" > "$RUNNER_TEMP/pro-entries"
grep -Fxq config.example.yml "$RUNNER_TEMP/pro-entries"
grep -Fxq dist/package.json "$RUNNER_TEMP/pro-entries"
if grep -Eq '^(dist/)?(config\.ya?ml|\.npmrc|\.env)$' "$RUNNER_TEMP/pro-entries"; then
  echo '::error::Archive contains private application configuration'
  exit 1
fi
