---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Document the Tegami entry format

Show the entry frontmatter template in AGENTS.md and spell out that
replay/exit-prerelease entries never bump a version, after a feature entry
used that form and was skipped by the Version Packages PR.
