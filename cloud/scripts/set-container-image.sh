#!/bin/sh
# Put a job image on Cloudflare Containers. Cloudflare cannot pull ghcr.io and
# runs linux/amd64 only, so this pulls the image for that platform, pushes it
# into Cloudflare's registry, and writes the pushed digest into
# wrangler.core.jsonc twice: every container class's `image`, and
# vars.HC_CONTAINER_IMAGE (what hc-core checks a job's image against and
# shows on the dashboard). A job that names the same repository by tag
# (ghcr.io/sprintengine/wingfoil-forecast:production) runs whatever version
# this last deployed.
#
# Usage, from anywhere, after `npx wrangler login` (needs Docker):
#   cloud/scripts/set-container-image.sh ghcr.io/sprintengine/wingfoil-forecast:production [--deploy]
# Without --deploy it stops before the deploy and prints the command.
set -eu
cd "$(dirname "$0")/.."
SOURCE="${1:?an image, for example ghcr.io/sprintengine/wingfoil-forecast:production}"
DEPLOY="${2:-}"
NAME="$(printf '%s' "$SOURCE" | sed -e 's/@sha256:.*$//' -e 's#.*/##' -e 's/:.*$//')"
LOCAL="$NAME:hc-$(date -u +%Y%m%d%H%M%S)"

docker pull --platform linux/amd64 "$SOURCE"
docker tag "$SOURCE" "$LOCAL"
npx wrangler -c wrangler.core.jsonc containers push "$LOCAL"

DIGEST_REF="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$LOCAL" | grep '^registry.cloudflare.com/' | grep "/$NAME@sha256:" | head -n 1)"
if [ -z "$DIGEST_REF" ]; then
  echo "Pushed, but Docker did not record the registry.cloudflare.com digest. Find it with" >&2
  echo "  npx wrangler -c wrangler.core.jsonc containers images list" >&2
  echo "and put registry.cloudflare.com/<account>/$NAME@sha256:<digest> in wrangler.core.jsonc by hand." >&2
  exit 1
fi

node --input-type=module - "$DIGEST_REF" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const ref = process.argv[2];
const file = "wrangler.core.jsonc";
const before = readFileSync(file, "utf8");
const after = before
  .replace(/("class_name":\s*"HcContainer[^"]*",\s*\n\s*"image":\s*)"[^"]*"/g, `$1"${ref}"`)
  .replace(/("HC_CONTAINER_IMAGE":\s*)"[^"]*"/, `$1"${ref}"`);
if (after === before) throw new Error(`${file} has no container image or HC_CONTAINER_IMAGE to set`);
writeFileSync(file, after);
console.log(`${file}: image and HC_CONTAINER_IMAGE are now ${ref}`);
NODE

if [ "$DEPLOY" = "--deploy" ]; then
  npx wrangler deploy -c wrangler.core.jsonc
else
  echo "Next: npx wrangler deploy -c wrangler.core.jsonc (from cloud/). Running containers keep their image until their run ends."
fi
