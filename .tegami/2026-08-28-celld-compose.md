---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Add a Compose-based Celld development loop

Add an ephemeral LocalStack S3 Compose service and document the native,
container, and load-measurement commands used by the private Celld QA package.
