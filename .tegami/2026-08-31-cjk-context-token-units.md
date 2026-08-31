---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Measure prompt tokens in serialized UTF-8 bytes

Default prompt measurement counted UTF-16 code units, so CJK text cost the
same units as ASCII of equal length. Adaptive calibration learned an inflated
marginal scale from CJK requests and applied it to every later request,
including ASCII prose and tool results, which could reject prompts that fit.
Measurement now divides serialized UTF-8 byte length by four. ASCII estimates
are unchanged; non-ASCII estimates increase and never decrease relative to the
previous basis.
