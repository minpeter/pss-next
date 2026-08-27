# Celld QA

This private package exercises the PSS runtime against a local Celld daemon.
It uses a bucket-backed deployment because Celld deliberately has no local
filesystem storage mode.

The scripts require a Celld binary, Docker for the container surface, and an
S3-compatible endpoint that passes Celld's conditional-write probe. Community
MinIO is not a supported backend. Set `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, and
`AWS_SECRET_ACCESS_KEY` before running the scripts.

```sh
pnpm --filter @minpeter/pss-celld-qa qa:native -- --port 16420 --object pss-smoke --text hello
pnpm --filter @minpeter/pss-celld-qa qa:matrix -- --native-port 16421 --container-port 16422 --objects 25 --concurrency 64
```

The matrix performs malformed-input, duplicate-idempotency, concurrent
object, and restart-persistence checks on both native and container Celld.
