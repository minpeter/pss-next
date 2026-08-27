# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-27T09:00:11Z
**Commit:** c199a20d
**Branch:** main

## OVERVIEW

Headless agent runtime plus the `pss` coding-agent CLI/TUI on top of it.
pnpm 11.9 workspaces + Turbo monorepo, Node >=24, strict TS ESM; tsdown builds, Vitest tests, ultracite/biome lint.

## STRUCTURE

```
pss-runtime/
├── packages/runtime/       # published @minpeter/pss-runtime 0.3.0-next.13; mega-barrel, 14 area dirs
├── apps/coding-agent/      # published @minpeter/pss-coding-agent 0.0.14-next.17; CLI/TUI + extension host
├── apps/worker-agent/      # private Cloudflare Worker + Telegram bot front; never published
├── extensions/{latex,mermaid,web}/  # publishable AND bundled into coding-agent dist
├── examples/               # six private runtime demos; in workspace, structural drift fails root tests
├── experimental/           # private live-provider benchmarks; cost money, PSS_BENCH_MODEL picks model
├── scripts/                # repo-invariant tests + release verification, run OUTSIDE Turbo
└── docs/                   # ADR 0001 (pi baseline), RFCs 0002-0004, compatibility manifests
```

`packages/extension-api` NO LONGER EXISTS - merged into coding-agent, shipped as
`@minpeter/pss-coding-agent/extension` (+`/legacy`). Extensions import that subpath.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Runtime engine (queue drain, compaction, kill) | `packages/runtime/src/thread/runtime/` | largest area; see its AGENTS.md |
| Durable platform contracts | `packages/runtime/src/execution/` | `AgentHost`/`HostStore`/checkpoints seam |
| Platform adapters (cf/file/memory) | `packages/runtime/src/platform/` | contract suites gate new platforms |
| CLI command router / QA table | `apps/coding-agent/` | run built `bin/pss.js` after CLI changes |
| TUI (pi-tui) | `apps/coding-agent/src/tui/` | mandatory web-terminal visual QA |
| File/shell tools | `apps/coding-agent/src/workspace-tools/` | hashline `LINE#ID` anchors |
| Extension authoring API | `apps/coding-agent/src/extensions/` | 9 capability kinds |
| Repo invariants / release checks | `scripts/` | 250 pure-LOC ceiling per script file |
| Compaction experiments | `experimental/compaction-score/` | paired CLI/validator convention |
| Eval harness | `examples/evals/` | `node --test`, NOT Vitest |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `createAgent` | fn | `packages/runtime` | public entry; docs pair it with `agent.thread("default")` |
| `turn.events()` | async iter | `runtime/src/thread` | backpressure: unconsumed turn never progresses (not a bug) |
| `AgentHost` / `HostStore` | iface | `runtime/src/execution` | durable contracts platforms implement |
| `pss.provide(...)` | fn | coding-agent extension API | all built-in extensions are thin factories on it |
| `resolveWorkspacePath` / `atomicWrite` | fn | coding-agent workspace-tools | REQUIRED for every workspace tool |

Hotspots: `apps/coding-agent/src/tui/agent.ts` (1694 lines, largest in repo),
`tui/app.ts` (935), `packages/runtime/src/llm/llm.test.ts` (1972),
`extensions/latex/src/latex-markdown.ts` (899).

## CONVENTIONS

- No `index.ts` in `thread/{handle,input,runtime}` or `platform/` - import concrete paths.
- Runtime declarations forbid `export *`; public API is snapshot-tested (`pnpm api:check`).
- Examples: `src/setup.ts` wiring + `src/index.ts` CLI loop; fixtures package-local, never shared.
- latex/mermaid register `{ fallback: true }` assistant renderers.
- An installed same-id extension shadows the copy bundled into coding-agent dist.

## ANTI-PATTERNS (THIS PROJECT)

- NEVER add NPM_TOKEN: releases use GitHub OIDC + npm Trusted Publishing.
- NEVER raise the 250 pure-LOC script ceiling (`scripts/file-size.test.mjs`); split modules.
- NEVER write `new Agent({`, `agent.session(`, or `~/.pss/sessions` in docs - asserted by `scripts/runtime-docs.test.mjs`.
- NEVER remove Telegram fragment coalescing (worker-agent).
- Attachment `MAX_IMAGE_*` ceilings are security limits, not defaults to relax.

## UNIQUE STYLES

- Tegami release notes: date-prefixed entries in `.tegami/`, validated by `pnpm check:tegami-notes` (see below).
- Prereleases on `next` tag (runtime + coding-agent); built-in extensions publish independently on `latest`.
- Storage stress profiles `PSS_RUNTIME_STORAGE_STRESS_PROFILE` (default/heavy/extreme/torture) after execution-store changes.

## COMMANDS

```bash
pnpm build|test|typecheck|lint   # root, via Turbo (scripts/*.test.mjs run outside Turbo)
pnpm dev:tui                     # run the TUI
pnpm api:check / pnpm api:update # runtime public API snapshot
pnpm tegami                      # release-notes tooling
```

Env knobs: `PSS_THREAD_DIR`, `PSS_THREAD_KEY`, `PSS_MODEL_CONTEXT_WINDOW`,
`PSS_DISABLE_UPDATE_CHECK`, `PSS_AUTO_UPDATE`, `PSS_LATEX*`, `PSS_MERMAID`.

## NOTES

- `experimental/nextjs-bench/results/` is ~35k committed generated files - always
  exclude from search: `rg --glob '!experimental/nextjs-bench/results/**'`.
- `experimental/` and `examples/` are in the workspace: a broken private package
  there fails `pnpm test` and CI. Benchmarks call live providers and cost money.
- Deeper guidance lives in child AGENTS.md files (`packages/runtime`, `apps/coding-agent`,
  `examples`, `experimental`, `scripts`, and their subtrees) - read the child, not just this file.

# Pull Requests

- Before merging a pull request, add a Tegami entry with a concise 1–3 line summary of the change.
- Use a patch-level release unless the pull request or user explicitly specifies a different release level.

# Tegami entries

Entries are `.tegami/YYYY-MM-DD-slug.md` files with frontmatter like:

```yaml
---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---
```

- Target the published package whose behavior changes: `npm:@minpeter/pss-runtime` or `npm:@minpeter/pss-coding-agent`. Changes under `extensions/` target `npm:@minpeter/pss-coding-agent` because the built-in extensions ship inside its bundle.
- Always use `type: patch` (or minor/major when asked). The `replay: exit-prerelease(...)` form is reserved for changes that must not bump a version (docs-only, CI-only); using it for a code change makes the Version Packages PR silently skip the entry.
- Give the entry body at least one `## <Title>` section. Tegami only drafts notes whose body parses into a markdown section, so a pending entry without any heading is silently never released; `pnpm check:tegami-notes` enforces this in CI.
- Copy the form from this template, not from an arbitrary existing entry.

# Releases

- Never merge the automated `Version Packages` pull request on your own. Merging it publishes to npm, so merge it only when the user explicitly asks to release (e.g. "릴리즈하자").
