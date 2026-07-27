---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add workspace coding tools and the headless `pss exec` runner

The coding agent now ships a workspace tool set shared by the TUI and a new
headless runner: `read_file`, `glob_files`, `grep_files`, `edit_file`
(hashline-anchored with stale-hash guards), `write_file`, `delete_file`, and
`shell_execute`. The file tools are confined to the workspace — path and
symlink escapes are rejected — and writes are atomic with the target
permissions applied from the outset. `shell_execute` is not a sandbox:
commands run with the user's permissions, but AI provider API keys are
withheld from the child environment.

`pss exec` runs one headless coding task for CI, benchmarks, and scripts. It
streams JSONL events (`metadata`, `agent_event`, `result`) to stdout and
exits 0 only when the task completes, with `--workspace`, exactly one of
`--prompt`/`--prompt-file`/`--stdin`, plus `--model`, `--base-url`,
`--timeout-seconds`, `--web-tools`, and `--result-file`. A `.env` next to the
working directory is loaded automatically.

Both surfaces share one production agent factory, `createCodingAgent`: the
workspace tools are always included and win name collisions, while a custom
`tools` option replaces only the optional web tools.
