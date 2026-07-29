# LaTeX Multilingual TUI PASS

## Objective

Make full-response LaTeX rendering in the coding-agent TUI consistently sized,
properly spaced, theme-readable, and reliably multilingual, with explicit
fallback instead of blank or partial output.

## Binding criteria

1. One-line native and Unicode formulas share the compact row class; every
   multi-row image owns a real trailing margin.
2. Korean, Japanese, Simplified and Traditional Chinese, accented Latin,
   Cyrillic, Greek, Arabic, Hebrew, Devanagari, Thai, and combining marks
   render visibly; RTL order is browser-probed; emoji visibly falls back.
3. Formula color resolves from host foreground, preserves
   `PSS_LATEX_COLOR`, and passes light/dark contrast fixtures.
4. Extension API, LaTeX, and coding-agent typechecks, tests, builds, lint,
   diagnostics, and frozen lock verification pass without skips.
5. A real generated Fermat response is captured through xterm.js in light and
   dark themes with Kitty PNG overlays and teardown evidence.

## Executed increments

### Baseline

- Commit `86a25b0`: Unicode MathJax rendering, direct Kitty placement,
  transparent PNGs, cache and regression coverage.

### Size and spacing

- RED: Unicode one-line grid was `8×2` versus native `4×1`; multi-row image
  had no semantic trailing blank.
- GREEN: renderer-aware display calibration, calibrated aspect geometry, and
  explicit post-image margin.
- Commit `8d07802`.

### Multilingual shaping

- RED: Simplified Chinese partial output, Arabic/Thai blank output, emoji
  silent loss, and absent RTL ordering evidence.
- GREEN: MathJax CHTML, browser-native shaping, script fonts, CJK locale,
  RTL grapheme geometry, visible-alpha cache validation, and emoji fallback.
- Commit `9b127ac`.

### Theme and visual QA

- RED: fixed `#767676` ignored host foreground and failed common theme
  contrast fixtures.
- GREEN: host foreground plumbing across extension API, TUI, and LaTeX cache.
- Browser clipping discovered during visual review was locked with multiline
  boxed Unicode tests, fixed by expanding shaped-run ancestor bounds, and
  invalidated with cache v10.
- Commit `654dda4`.

## Evidence

- Durable execution ledger:
  `/tmp/ulw-20260729-100838.s5C25x.md`
- Final xterm artifacts:
  `.omo/evidence/latex-xterm-visual-qa/final-v10-clean-20260729T034814Z/`
- `qa-result.json`: `passed: true`, 11 formulas, all margins true.
- `teardown.json`: terminal, browser, crashpad handlers, and server closed.
- Two independent final visual reviewers returned PASS.
- LaTeX suite: 33 tests passed.
- Coding-agent suite: 504 tests passed across 82 files.
- Extension API, LaTeX, and coding-agent typechecks and builds passed.
- Monorepo lint, frozen lock verification, diff check, and diagnostics passed.

## Commit and review gate

All implementation commits use repository Conventional Commit style and carry
the durable plan footer. Final Momus approval is required against this plan,
the ledger, commits, and artifacts before goal completion.
