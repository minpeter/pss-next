<p align="center">
  <img src="assets/runtime-banner.png" alt="Plugsuits next banner" width="100%" />
</p>

# Plugsuits <sub><sup>next</sup></sub>

> Just want the terminal agent? [`apps/coding-agent`](apps/coding-agent/README.md)
> opens with the install steps for the `pss` TUI and the `pss exec` runner.

Small agent runtime workspace. Everything ships under the `pss` prefix, short
for Plugsuits.

- [`@minpeter/pss-runtime`](packages/runtime/README.md): runtime, threads,
  model loop, core hooks, storage, and instrumentation.
- [`@minpeter/pss-coding-agent`](apps/coding-agent/README.md): model wiring,
  workspace coding tools, the `pss` TUI, and the `pss exec` headless runner.

## Use

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
});

const agent = await createAgent({
  instructions: "Keep every answer under 3 lines.",
  model: provider(process.env.AI_MODEL ?? "minimax/MiniMax-M3"),
});

const thread = agent.thread("default");
const turn = await thread.send("Hello");

for await (const event of turn.events()) {
  console.dir(event, { depth: null });
}
```

`turn.events()` drives the turn. The runtime waits at `turn-start`,
`step-start`, and `step-end` until the consumer continues, so consume the
events to let the turn progress.

## License

This project is licensed under the [Sustainable Use License](LICENSE.md).

You can use, modify, and distribute it for free for internal business,
non-commercial, or personal use. Reselling it or offering it as a paid product
or service requires a separate commercial license.
