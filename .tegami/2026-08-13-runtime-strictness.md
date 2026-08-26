---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## TypeScript strictness

Enforce `exactOptionalPropertyTypes` for the runtime OpenTelemetry subsystem and preserve absent optional OpenTelemetry fields instead of materializing `undefined`.
