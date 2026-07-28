---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Load AGENTS.md context files, prompt templates, and skills

pss now loads file-based context resources without requiring an extension.
`AGENTS.md` context files are discovered from `~/.pss/AGENTS.md` and from
the repository root (the first ancestor containing `.git`) down to the
working directory, closest file last, and injected into the system prompt
in both the TUI and headless exec.

Prompt templates (`~/.pss/prompts/*.md` globally,
`<project>/.pss/prompts/*.md` trust-gated per project) become `/name`
slash commands in the TUI and expand `pss exec` prompts of the form
`/name args`. `$ARGUMENTS` receives the full argument string and
`$1`–`$9` positional arguments in a single substitution pass, so
placeholder-like text inside arguments is never re-substituted; bodies
without placeholders get the arguments appended. An optional
`description:` frontmatter line labels the command. Built-in and extension
commands always win name collisions; shadowed templates are skipped with a
notice, and project templates beat global ones, which beat
extension-contributed ones.

Skills are `skills/<name>/SKILL.md` directories with `name`/`description`
frontmatter, discovered globally and (trust-gated) per project. Only the
metadata loads eagerly; the system prompt lists each skill and the model
reads the `SKILL.md` on demand when a task matches.

Extensions contribute prompt and skill directories with the new
`resources` capability (absolute paths, validated). Untrusted project
resources stay blocked with a notice — the same trust gate the extension
loader uses — and malformed trust settings fail safe. Context resources
are re-discovered by `/reload`, so edits apply without a restart; a failed
reload keeps the previous resources with the previous runtime.
