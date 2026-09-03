---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Cancel in-flight web tool requests

Forward coding-agent abort signals to web search and page fetch clients so active network work can stop promptly.
