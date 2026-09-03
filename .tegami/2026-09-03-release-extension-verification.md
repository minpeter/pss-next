---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Verify independently published extensions

Include the LaTeX, Mermaid, and web extension artifacts in the default release
verification. Fail closed when an extension manifest, public entrypoint, or
runtime worker is malformed or missing, run publint for each extension package,
and import every packed extension entrypoint in the consumer smoke before
publishing.
