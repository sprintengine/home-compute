#!/bin/bash
# Runs a command against a throwaway Colima profile, then deletes it:
#
#   agent/scripts/with-test-colima.sh node --test agent/test/docker-real.test.mjs
#
# The profile (HC_TEST_PROFILE, default hc-test; 1 CPU, 1 GiB, 10 GiB disk)
# starts with --activate=false, so the current docker context (perhaps a
# Colima `default` that something else uses) is never switched, and the
# command sees only HC_TEST_DOCKER_HOST, the profile's own socket. The
# profile is stopped and deleted however the command ends. It refuses to
# touch a profile called `default`, or one that already exists.
set -euo pipefail
profile="${HC_TEST_PROFILE:-hc-test}"
if [ "$profile" = default ]; then echo "with-test-colima: refusing to use the default profile" >&2; exit 2; fi
if [ $# -eq 0 ]; then echo "usage: $0 COMMAND [ARGS…]" >&2; exit 2; fi
if colima list --json 2>/dev/null | grep -q "\"name\":\"$profile\""; then
  echo "with-test-colima: profile $profile already exists; delete it first (colima delete $profile --force --data)" >&2
  exit 2
fi
cleanup() {
  colima stop "$profile" >/dev/null 2>&1 || colima stop --force "$profile" >/dev/null 2>&1 || true
  colima delete "$profile" --force --data >/dev/null 2>&1 || true
  echo "with-test-colima: profile $profile stopped and deleted" >&2
}
trap cleanup EXIT INT TERM
started=$(date +%s)
colima start "$profile" --runtime docker --vm-type vz --cpus "${HC_TEST_CPUS:-1}" --memory "${HC_TEST_MEMORY_GIB:-1}" --disk 10 \
  --activate=false --ssh-config=false --mount none >&2
echo "with-test-colima: $profile up in $(( $(date +%s) - started )) s" >&2
export HC_TEST_DOCKER_HOST="unix://${COLIMA_HOME:-$HOME/.colima}/$profile/docker.sock"
"$@"
