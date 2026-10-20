# Not a workload. wrangler.core.jsonc points here so the Worker config is valid
# before an image has been pushed to Cloudflare's registry. Replace
# containers[0].image with registry.cloudflare.com/<account>/<repo>@sha256:…
# (the same digest as the HC_CONTAINER_IMAGE secret) before any real job.
FROM alpine:3.20
CMD ["echo", "home-compute cloudflare container placeholder"]
