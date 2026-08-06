---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add the versioned JSONL agent protocol

Add a versioned transport-neutral JSONL RPC protocol, TypeScript client, and Node spawn transport.
Expose coding-agent prompt, steer, abort, and state operations through a protocol-clean stdio mode.
