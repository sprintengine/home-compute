#!/bin/sh
# Put a job image on Cloudflare Containers. Cloudflare cannot pull ghcr.io and
# runs linux/amd64 only, so this copies the image's linux/amd64 platform into
# Cloudflare's registry and writes into wrangler.core.jsonc:
#   - every container class's `image` and vars.HC_CONTAINER_IMAGE: the copy,
#     by digest (what runs, and what the dashboard shows);
#   - vars.HC_CONTAINER_SOURCE: the image it came from, by its multi-platform
#     digest, so a job pinned to that ghcr digest runs here too.
# A job that names the same repository by tag
# (ghcr.io/sprintengine/wingfoil-forecast:production) runs whatever version
# this last deployed.
#
# Usage, from anywhere, after `npx wrangler login`:
#   cloud/scripts/set-container-image.sh ghcr.io/sprintengine/wingfoil-forecast:production [--deploy]
# With `crane` (brew install crane) no Docker is needed; it must be able to read
# the source (for a private ghcr image: gh auth token | crane auth login ghcr.io -u <user> --password-stdin).
# Without crane, Docker pulls and pushes instead. Without --deploy it stops
# before the deploy and prints the command.
set -eu
cd "$(dirname "$0")/.."
SOURCE="${1:?an image, for example ghcr.io/sprintengine/wingfoil-forecast:production}"
DEPLOY="${2:-}"
NAME="$(printf '%s' "$SOURCE" | sed -e 's/@sha256:.*$//' -e 's#.*/##' -e 's/:.*$//')"
TAG="hc-$(date -u +%Y%m%d%H%M%S)"
ACCOUNT="$(npx wrangler whoami --json 2>/dev/null | node -e 'let t="";process.stdin.on("data",(c)=>t+=c).on("end",()=>{try{const a=JSON.parse(t).accounts??[];if(a.length===1)console.log(a[0].id)}catch{}})')"
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-$ACCOUNT}" ]; then
  echo "Set CLOUDFLARE_ACCOUNT_ID: wrangler is signed in to more than one account, or to none." >&2
  exit 1
fi
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-$ACCOUNT}"
TARGET="registry.cloudflare.com/$ACCOUNT/$NAME:$TAG"

if command -v crane >/dev/null 2>&1; then
  SOURCE_REF="$(printf '%s' "$SOURCE" | sed 's/@sha256:.*$//')@$(crane digest "$SOURCE")"
  npx wrangler containers registries credentials registry.cloudflare.com --push --pull --expiration-minutes 30 --json \
    | node -e 'let t="";process.stdin.on("data",(c)=>t+=c).on("end",()=>{const c=JSON.parse(t);process.stdout.write(`${c.username ?? c.user ?? "v1"}\n${c.password}`)})' \
    | { read -r USERNAME; crane auth login registry.cloudflare.com -u "$USERNAME" --password-stdin; }
  crane copy --platform linux/amd64 "$SOURCE" "$TARGET"
  DIGEST_REF="registry.cloudflare.com/$ACCOUNT/$NAME@$(crane digest "$TARGET")"
else
  docker pull --platform linux/amd64 "$SOURCE"
  SOURCE_REF="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$SOURCE" | head -n 1)"
  docker tag "$SOURCE" "$NAME:$TAG"
  npx wrangler -c wrangler.core.jsonc containers push "$NAME:$TAG"
  DIGEST_REF="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$NAME:$TAG" | grep '^registry.cloudflare.com/' | grep "/$NAME@sha256:" | head -n 1)"
fi
if [ -z "$DIGEST_REF" ]; then
  echo "Pushed, but the registry.cloudflare.com digest is unknown. Find it with" >&2
  echo "  npx wrangler -c wrangler.core.jsonc containers images list" >&2
  exit 1
fi

node --input-type=module - "$DIGEST_REF" "$SOURCE_REF" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [ref, source] = process.argv.slice(2);
const file = "wrangler.core.jsonc";
const before = readFileSync(file, "utf8");
const after = before
  .replace(/("class_name":\s*"HcContainer[^"]*",\s*\n\s*"image":\s*)"[^"]*"/g, `$1"${ref}"`)
  .replace(/("HC_CONTAINER_IMAGE":\s*)"[^"]*"/, `$1"${ref}"`)
  .replace(/("HC_CONTAINER_SOURCE":\s*)"[^"]*"/, `$1"${source}"`);
if (after === before) throw new Error(`${file} has no container image or HC_CONTAINER_IMAGE to set`);
writeFileSync(file, after);
console.log(`${file}: image ${ref}, copied from ${source}`);
NODE

if [ "$DEPLOY" = "--deploy" ]; then
  npx wrangler deploy -c wrangler.core.jsonc
else
  echo "Next: npx wrangler deploy -c wrangler.core.jsonc (from cloud/). Running containers keep their image until their run ends."
fi
