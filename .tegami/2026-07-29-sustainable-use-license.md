---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## License the workspace under the Sustainable Use License

The repository previously shipped without a license file, leaving published
packages with no stated terms. `LICENSE.md` now declares the Sustainable Use
License 1.0 at the workspace root and is mirrored into the two published
packages, which set `"license": "SEE LICENSE IN LICENSE.md"` and include the
file in their published `files` list.

Internal business, non-commercial, and personal use stay free, including
modification and free redistribution. Reselling the software or offering it as
a paid product or service requires a separate commercial license.
