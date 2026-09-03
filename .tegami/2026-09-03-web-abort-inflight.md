---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-extension-web:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-web)
---

## Cancel in-flight web tool requests

Forward coding-agent abort signals to web search and page fetch clients so active network work can stop promptly.
