# Wave 1 — OSS coding-agent comparison

## Cross-project result
- OpenCode: converts AI SDK errors into a discriminated union carrying status,
  retryability, headers/body, and metadata; heuristics are secondary.
- Codex CLI: exhaustive typed `CodexErr` and `CodexErrorInfo` cross the
  core/TUI boundary as data.
- Gemini CLI: parses structured Google RPC detail first, then HTTP status, then
  string fallback; detailed diagnostics are opt-in.
- Aider: delegates normalization to LiteLLM exception classes, then maps class
  to retry policy and friendly description.
- Continue: pure message heuristics; useful as a negative example despite rich
  remediation text.

## Primary sources
- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/opencode/src/provider/error.ts
- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/opencode/src/session/retry.ts
- https://github.com/openai/codex/blob/205d37a20f742b0bf8e191622bd07c43f567ea49/codex-rs/protocol/src/error.rs
- https://github.com/google-gemini/gemini-cli/blob/87f785192c34067e4e8f26bda16cf9ce24014d83/packages/core/src/utils/errors.ts
- https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/exceptions.py
- https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/util/errorAnalysis.ts

## EXPAND markers
- LEAD: inspect exact OpenCode normalizer invocation and persisted schema —
  WHY: closest TypeScript/AI-SDK analogue — ANGLE: migration mechanics.
- LEAD: inspect Codex UI projection truncation and correlation metadata — WHY:
  mature terminal behavior — ANGLE: presentation boundary.

## Claim verdicts
- CONFIRMED: structured-first classification is the dominant mature design.
- CONFIRMED: Continue's message-first implementation exhibits the same
  overfitting concern raised by the user.
