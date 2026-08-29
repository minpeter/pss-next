# Celld QA

This private package exercises the PSS runtime against a local Celld daemon.
It uses a bucket-backed deployment because Celld deliberately has no local
filesystem storage mode.

The scripts require a Celld binary, Docker for the container surface, and an
S3-compatible endpoint that passes Celld's conditional-write probe. Community
MinIO is not a supported backend. Set `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, and
`AWS_SECRET_ACCESS_KEY` before running the scripts.

## Docker Compose development loop

The package includes an ephemeral LocalStack S3 service bound only to loopback.
Build the runtime first because the deployed QA worker imports the published
`@minpeter/pss-runtime/platform/durable-object/celld` subpath.

```sh
pnpm --filter @minpeter/pss-runtime build
pnpm --filter @minpeter/pss-celld-qa qa:s3:up
```

The default QA environment already matches the Compose service:

```sh
export S3_ENDPOINT=http://127.0.0.1:14566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
```

Run the native smoke test and native/container durability matrix:

```sh
pnpm --filter @minpeter/pss-celld-qa qa:native -- --port 16420 --object pss-smoke --text hello
pnpm --filter @minpeter/pss-celld-qa qa:matrix -- --native-port 16421 --container-port 16422 --objects 25 --concurrency 64
```

Capture the reproducible response-retention baseline and candidate:

```sh
CELLD_QA_RETENTION_MODE=legacy pnpm --filter @minpeter/pss-celld-qa qa:load -- \
  --port 16423 --objects 100 --concurrency 64 \
  --output /var/tmp/pss-celld-baseline.json
pnpm --filter @minpeter/pss-celld-qa qa:load -- \
  --port 16423 --objects 100 --concurrency 64 \
  --output /var/tmp/pss-celld-candidate.json
pnpm --filter @minpeter/pss-celld-qa qa:compare -- \
  /var/tmp/pss-celld-baseline.json /var/tmp/pss-celld-candidate.json
```

Stop the S3 service and remove its ephemeral data:

```sh
pnpm --filter @minpeter/pss-celld-qa qa:s3:down
```

Set `CELLD_QA_S3_PORT` before `qa:s3:up` to change the host port, and set
`S3_ENDPOINT` to the matching URL for the QA commands. The Compose file does
not declare a persistent volume, so `qa:s3:down` removes all LocalStack data.

The matrix performs malformed-input, duplicate-idempotency, concurrent
object, restart-persistence, and completed-idempotency replay checks on both
native and container Celld. Its idempotency reservation is durable: an
interrupted pending request returns `409` rather than repeating agent effects.

`qa:load` also records Celld process RSS, CPU ticks, and file descriptors for
diagnostics. The optimization gate is intentionally narrower and causal: it
compares response objects and serialized response bytes retained by the QA
runner. Celld process metrics are observational because runner-side retention
cannot causally change the Celld child process.

## Complete validation campaign

The campaign commands emit schema-validated JSON reports plus machine-readable
cleanup receipts. Use a separate loopback port for each live profile.

```sh
evidence=/var/tmp/pss-celld-campaign
mkdir -p "$evidence"

pnpm --filter @minpeter/pss-celld-qa qa:s3:up
pnpm --filter @minpeter/pss-celld-qa qa:real-agent -- \
  --scenario all --port 16430 --report "$evidence/real-agent.json"
pnpm --filter @minpeter/pss-celld-qa qa:chaos -- \
  --scenario all --scheduled-items 1000 --report "$evidence/chaos.json"
pnpm --filter @minpeter/pss-celld-qa qa:profiles -- \
  --profiles wide,hot,mixed,restart,soak --port 16431 \
  --progress "$evidence/profile-progress.jsonl" \
  --report "$evidence/profiles.json"
pnpm --filter @minpeter/pss-celld-qa qa:s3-faults -- \
  --proxy-url http://127.0.0.1:14567 \
  --control-url http://127.0.0.1:14568 \
  --toxiproxy-url http://127.0.0.1:18474 \
  --s3-url http://127.0.0.1:14566 \
  --report "$evidence/s3-faults.json"
```

The profile command defaults `CELLD_ACTIVATIONS` to `128`. This lets the
256-wide cold-object burst make progress through the intentional 100-cell
residency cap without queued activations expiring. Set `CELLD_ACTIVATIONS`
explicitly to override the campaign default.

Verify every report before accepting evidence:

```sh
for report in "$evidence"/*.json; do
  pnpm --filter @minpeter/pss-celld-qa qa:verify -- "$report"
done
pnpm --filter @minpeter/pss-celld-qa qa:s3:down
```

The real-agent workload covers tool checkpoint restart with an explicit
checkpoint-proven orphan lease release and reports replay executions separately
from the business-deduplicated committed effect, durable input ordering,
compaction recovery, large payload integrity, and attachment hydration. Chaos
tests scheduler/drainer boundaries, thousand-row ordering, legacy SQLite
migration, and the shared Cloudflare adapter. Profiles capture p50/p95/p99
latency over a rolling window capped at 4,096 samples plus native Celld CPU,
RSS, and file-descriptor observations. The loopback-only S3 campaign covers
latency, timeout, reset, HTTP 500, throttling, a real LocalStack restart,
read-after-write visibility, and conditional-write failures. Every fault must
show injection, recovery, convergence, and one committed effect.

The Compose stack starts LocalStack, Toxiproxy, and the typed fault proxy.
Override their loopback ports with `CELLD_QA_S3_PORT`,
`CELLD_QA_TOXIPROXY_CONTROL_PORT`, `CELLD_QA_TOXIPROXY_DATA_PORT`,
`CELLD_QA_FAULT_PROXY_PORT`, and `CELLD_QA_FAULT_CONTROL_PORT`.
