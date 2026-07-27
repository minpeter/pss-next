---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Fix the frozen "0 tokens (0 in / 0 out)" footer and make it live

The OpenAI-compatible provider is now created with `includeUsage: true`, so
streaming responses carry token usage (`stream_options:
{"include_usage": true}`). Previously usage chunks were never requested,
every `model-usage` event arrived without token counts, and the TUI footer
stayed at "0 tokens (0 in / 0 out)" forever.

The footer also updates live while the model streams: assistant text,
reasoning, and tool-call input fragments feed a chars-based estimate
(prefixed with `≈`) that is replaced by the authoritative per-step usage as
soon as it arrives. When no usage was ever reported and nothing is
streaming, the footer is hidden instead of claiming a false zero.
