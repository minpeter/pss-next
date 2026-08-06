# Extended verification

Pull requests stay on the fast Ubuntu CI matrix in `ci.yml`. Expensive or environment-specific checks live in `extended-verification.yml`:

- runtime storage uses the `heavy` stress profile every Monday;
- the Worker dry-run and the small real-provider eval suite run every Thursday;
- path, file-lock, CLI, and terminal/TUI smoke tests run on macOS and Windows monthly;
- every suite can be selected manually, while the deployed-Worker probe is manual-only.

Live checks first run a credential gate. Scheduled and `all` runs skip unavailable optional suites with a successful summary. Explicitly selecting `live-provider` or `remote-edge` fails when its required credentials are missing so a requested check cannot silently pass without running. `AI_API_KEY` enables real-mode provider evals; `AI_BASE_URL` and `AI_MODEL` are optional provider overrides. The remote edge suite combines those real-mode worker evals with the deployed production-Worker probe and additionally requires `WORKER_AGENT_TUI_ENDPOINT` plus `WORKER_AGENT_TUI_TOKEN`. Secrets are passed only to the step that consumes them.

## Large generated JSON policy

Biome does not lint JSON files at or above its 1 MiB file-size limit. Such files must therefore be generated evidence, never hand-maintained configuration or executable application data. They must live beside their benchmark/evidence owner, have a deterministic focused verifier, and be reviewed through that owner's schema and integrity tests. Do not raise Biome's global limit or add a second repository-wide benchmark validator merely to lint generated evidence: benchmark boundaries and allowlists remain owned by the producing project. Any new non-benchmark JSON that approaches the limit must be split or moved to a typed/generated format before merge.
