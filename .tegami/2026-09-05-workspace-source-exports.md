---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Workspace source exports

Place the opt-in `@minpeter/pss-source` workspace source condition before `types` in package exports.
Default published consumers continue to resolve declarations and JavaScript from `dist`.
