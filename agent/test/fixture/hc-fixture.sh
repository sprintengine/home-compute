#!/bin/sh
# hc-fixture MODE [ARGS]: what the agent's Docker tests run.
#
#   report        prints lines, a progress bar rewritten with carriage returns,
#                 a line on stderr, the fake secret in $HC_FAKE_SECRET (which
#                 must arrive redacted) and a json-lines report; exits 0
#   alloc MiB S   holds MiB of memory for S seconds (dd's buffer, blocked on a pipe)
#   oom           allocates 256 MiB, past a 64 MiB limit
#   sleep S       sleeps S seconds (past runSeconds, for the timeout)
#   fail N        prints an error line and exits N
#   slow N        prints a line a second for N seconds, with the secret
set -o pipefail 2>/dev/null
mode="${1:-report}"
case "$mode" in
  report)
    echo "starting fixture"
    echo "using token $HC_FAKE_SECRET"
    printf 'download 10%%\rdownload 55%%\rdownload 100%%\n'
    echo "a note on stderr" >&2
    echo '{"event":"forecast_complete","model":"fixture","run":"2026101100","frames":3,"peakRssBytes":1234567}'
    echo "done"
    ;;
  alloc)
    echo "allocating ${2:-320} MiB for ${3:-8} s"
    dd if=/dev/zero bs="${2:-320}M" count=1 2>/dev/null | sleep "${3:-8}"
    echo '{"event":"alloc_complete","peakRssBytes":'"$(( ${2:-320} * 1048576 ))"'}'
    ;;
  oom)
    echo "allocating 256 MiB"
    dd if=/dev/zero bs=256M count=1 2>/dev/null | sleep 5
    exit $?
    ;;
  sleep)
    echo "sleeping ${2:-600} s"
    exec sleep "${2:-600}"
    ;;
  fail)
    echo "working"
    echo "ERROR: failing on purpose" >&2
    exit "${2:-3}"
    ;;
  slow)
    i=0
    while [ "$i" -lt "${2:-5}" ]; do
      echo "tick $i $HC_FAKE_SECRET"
      i=$((i + 1))
      sleep 1
    done
    ;;
  *)
    echo "hc-fixture: unknown mode $mode" >&2
    exit 2
    ;;
esac
