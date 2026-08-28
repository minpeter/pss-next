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
`@minpeter/pss-runtime/platform/celld` subpath.

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
