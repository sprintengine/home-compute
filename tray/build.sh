#!/usr/bin/env bash
# Builds home-compute-tray for Windows and Linux into tray/dist/:
#   home-compute-tray-windows-amd64.exe, home-compute-tray-linux-amd64, home-compute-tray-linux-arm64
# with SHA256SUMS. Pure Go (CGO_ENABLED=0), so it cross-compiles from any machine with Go 1.26+.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
rm -rf dist
mkdir -p dist
for target in windows/amd64 linux/amd64 linux/arm64; do
  os="${target%/*}"
  arch="${target#*/}"
  name="home-compute-tray-$os-$arch"
  flags="-s -w -X main.version=$VERSION"
  if [ "$os" = windows ]; then
    name="$name.exe"
    # A GUI program: no console window opens with it.
    flags="$flags -H=windowsgui"
  fi
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$flags" -o "dist/$name" .
  echo "built dist/$name ($(wc -c < "dist/$name" | tr -d ' ') bytes)"
done
(cd dist && shasum -a 256 home-compute-tray-* > SHA256SUMS 2>/dev/null || sha256sum home-compute-tray-* > SHA256SUMS)
