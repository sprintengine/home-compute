#!/bin/sh
# Push one linux/amd64 image into Cloudflare's registry so a job can run it.
# Cloudflare Containers do not pull ghcr.io. They also run amd64 only, so a
# multi-arch ghcr image must be pulled for that platform before the push.
#
# Usage, from cloud/, after `npx wrangler login`:
#   ./scripts/push-container-image.sh ghcr.io/org/app@sha256:<64 hex> [local-tag]
# Then set wrangler.core.jsonc containers[0].image and the HC_CONTAINER_IMAGE
# secret to the registry.cloudflare.com/…@sha256:… line this prints.
set -eu
cd "$(dirname "$0")/.."
SOURCE="${1:?source image, for example ghcr.io/org/app@sha256:<digest>}"
TAG="${2:-home-compute-job}"
docker pull --platform linux/amd64 "$SOURCE"
docker tag "$SOURCE" "$TAG"
npx wrangler -c wrangler.core.jsonc containers push "$TAG"
echo "Set containers[0].image and the HC_CONTAINER_IMAGE secret to the registry.cloudflare.com digest:"
npx wrangler -c wrangler.core.jsonc containers images list
docker image inspect --format '{{json .RepoDigests}}' "$TAG" || true
