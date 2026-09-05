---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Workspace source exports

Place the opt-in `@minpeter/pss-source` workspace source condition before `types` in package exports.
Default published consumers continue to resolve declarations and JavaScript from `dist`.
