---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Fix token usage footer accounting

Avoid recounting cached and reasoning prompt tokens when aggregating token usage in the coding-agent footer.
