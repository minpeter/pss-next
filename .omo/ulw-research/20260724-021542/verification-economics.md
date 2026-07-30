# Verification economics

## Proof-cost policy
- Local code claims: verify directly from absolute source paths and line ranges.
- SDK claims: prefer official documentation or installed package source.
- OSS behavior claims: require primary repository source; avoid screenshots and
  blog summaries when source is available.
- Security/robustness claims: require at least two independent implementations
  or one primary contract plus an adversarial counterexample.
- Do not run provider calls; this research concerns classification contracts,
  not current account status.
