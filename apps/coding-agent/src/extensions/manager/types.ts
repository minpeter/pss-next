import type { CodingAgentExtensionInput, ExtensionJsonValue } from "../types";

export type ExtensionScope = "global" | "project";
export type ExtensionSourceKind = "git" | "local" | "npm";

export type ExtensionTarget =
  | {
      readonly kind: "module";
      readonly path: string;
    }
  | {
      readonly kind: "package";
      readonly packageName: string;
    };

export interface ExtensionSettingsEntry {
  readonly config?: Readonly<Record<string, ExtensionJsonValue>>;
  readonly enabled: boolean;
  readonly id: string;
  readonly installedAt: string;
  readonly source: string;
  readonly sourceKind: ExtensionSourceKind;
  readonly target: ExtensionTarget;
  readonly updatedAt?: string;
}

export interface ListedExtension extends ExtensionSettingsEntry {
  readonly scope: ExtensionScope;
  readonly status: "blocked" | "disabled" | "enabled";
}

export interface LoadedConfiguredExtensions {
  readonly extensions: readonly CodingAgentExtensionInput[];
  readonly notices: readonly string[];
}

export interface CommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type RunExtensionCommand = (
  command: string,
  args: readonly string[]
) => Promise<CommandResult>;

export type ImportExtensionModule = (specifier: string) => Promise<unknown>;

export interface ExtensionManagerContext {
  readonly cwd: string;
  readonly home: string;
  readonly importer?: ImportExtensionModule;
  readonly now?: () => Date;
  readonly runCommand?: RunExtensionCommand;
}
