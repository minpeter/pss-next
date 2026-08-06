---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Keep generated benchmarks out of boundary checks

Store Next.js benchmark results in the repository artifact root and migrate the
legacy package-local directory so generated projects stay outside boundary scans
without disabling checks for the benchmark source package.
