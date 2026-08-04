---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-extension-web:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-web)
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Update the AI SDK

Update runtime and consumer packages to AI SDK 7.0.51 for consistent tool types and downstream version alignment.
