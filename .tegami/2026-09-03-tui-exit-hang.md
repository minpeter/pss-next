---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Let the TUI exit while selectors are pending

Cancel pending model and session selector waits when exit is requested so catalog loading or an open picker cannot keep the process alive.
