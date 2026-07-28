---
packages:
  npm:@minpeter/pss-extension-api:
    type: patch
---

## Publish shared coding-agent extension contracts

Add a small, host-agnostic package for instruction and assistant-renderer
capabilities, renderer lifecycle types, and extension factory composition.
Official extension packages can now depend on the authoring contract without
creating a runtime dependency on coding-agent, while coding-agent continues to
re-export the same public authoring surface.
