import { registerHooks } from "node:module";

// A subprocess-only terminal seam. Observe, but do not replace, real workspace
// tools and context loading; no provider request is allowed during startup.
globalThis.fetch = () => {
  throw new Error("Unexpected network request");
};
globalThis.__devTuiProbe = {};

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/workspace-tools/index.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { createWorkspaceTools as original } from ${JSON.stringify(`${url}?probe-original`)};
          export function createWorkspaceTools(options) {
            const tools = original(options);
            globalThis.__devTuiProbe.tools = tools;
            return tools;
          }
        `,
      };
    }
    if (url.endsWith("/context/index.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export * from ${JSON.stringify(`${url}?probe-original`)};
          import { loadContextResources as original } from ${JSON.stringify(`${url}?probe-original`)};
          export async function loadContextResources(options) {
            const resources = await original(options);
            globalThis.__devTuiProbe.contextPaths = resources.agentsFiles.map(({ path }) => path);
            return resources;
          }
        `,
      };
    }
    if (url.endsWith("/tui/agent.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { readSessionIndex, sessionIndexPath } from '../sessions/session-index.ts';
          export async function createAgentTUI(config) {
            const { sessions } = await readSessionIndex(sessionIndexPath(process.env.PSS_THREAD_DIR));
            const probe = globalThis.__devTuiProbe;
            const read = await probe.tools.read_file.execute({ path: 'workspace-marker.txt' }, {
              context: {}, messages: [], toolCallId: 'launcher-probe',
            });
            console.log('__DEV_TUI_PROBE__' + JSON.stringify({
              processCwd: process.cwd(),
              initCwd: process.env.INIT_CWD,
              autocompleteCwd: config.cwd ?? process.cwd(),
              sessions: sessions.map(({ cwd, key }) => ({ cwd, key })),
              contextPaths: probe.contextPaths,
              callerFileRead: read.includes('CALLER_WORKSPACE_SENTINEL'),
              model: process.env.AI_MODEL,
              baseURL: process.env.AI_BASE_URL,
              apiKey: process.env.AI_API_KEY,
            }));
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});
