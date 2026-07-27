# PSS benchmark shared harness utilities

Benchmark-agnostic machinery shared by the packages under `benchmarks/`. A
benchmark package should only own its harness adapter, fixture pins, and
profile definitions — everything reusable lives here.

## Exports

- `@minpeter/pss-bench-shared/lock` — `createDirectoryLock`: a cross-process
  directory lock (atomic mkdir, unique owner token, stale reclaim) for
  benchmark maintenance tasks that share mutable state.
- `@minpeter/pss-bench-shared/pack-agent` — `packAgentArtifact`: build and
  pack an agent workspace package into a stable-named tarball plus a sha256
  manifest, so a campaign can prove which agent code ran.
- `@minpeter/pss-bench-shared/scoring` — `scoreCampaign`/`formatScoreCsv`:
  aggregate agent-eval summaries and transcripts into pass metrics and token
  usage.
- `@minpeter/pss-bench-shared/score-cli` — `scoreCampaignCommand`: CLI flow
  that scores the latest (or given) campaign and writes score.json/score.csv.
- `@minpeter/pss-bench-shared/config` — `asSet`/`resolvePositiveInteger`:
  environment/CLI value resolution (blank counts as unset, values trimmed).
- `@minpeter/pss-bench-shared/check-scripts` — `checkNodeScripts`: the
  syntax-check build gate for benchmark packages written as plain `.mjs`
  (no transpile step).

Consumers declare `"@minpeter/pss-bench-shared": "workspace:*"` and keep
thin wrapper scripts so existing `pnpm <script>` entry points stay stable.
