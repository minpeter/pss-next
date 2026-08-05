---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-extension-latex:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-latex)
  npm:@minpeter/pss-extension-mermaid:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-mermaid)
---

## Add Mermaid ASCII diagram renderer with composable assistant renderers

Compose fallback assistant renderers into an ordered chain, and render mermaid fences as CJK-safe Unicode box art below their preserved source via the new mermaid extension.
