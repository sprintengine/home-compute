# The agent's Docker test workload (test/docker-real.test.mjs): busybox and
# one shell script, so it builds in seconds on any Docker.
FROM busybox:1.37
COPY hc-fixture.sh /usr/local/bin/hc-fixture
ENTRYPOINT ["/usr/local/bin/hc-fixture"]
