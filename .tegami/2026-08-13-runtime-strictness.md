---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## TypeScript strictness

Enforce `exactOptionalPropertyTypes` for the runtime OpenTelemetry subsystem and preserve absent optional OpenTelemetry fields instead of materializing `undefined`.
