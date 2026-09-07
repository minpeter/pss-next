---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Clarify write_file hash preconditions

New files omit `expected_file_hash`; guarded overwrites copy the exact eight-character lowercase hash from the latest successful `read_file` for the same existing path, without placeholders or null.
Reject malformed hashes (including uppercase, never normalized) as SDK invalid input; `00000000` remains syntactically valid, not a missing-file sentinel.
Distinct `FILE_HASH_MISMATCH` and `FILE_HASH_TARGET_MISSING` execution errors explain how to proceed without weakening stale-overwrite checks.
