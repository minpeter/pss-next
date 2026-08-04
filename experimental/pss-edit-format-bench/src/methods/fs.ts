import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const resolveUnderWorkspace = (
  workspace: string,
  inputPath: string
): string => {
  const root = resolve(workspace);
  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(root, inputPath);
  const offset = relative(root, candidate);
  if (offset.startsWith("..") || isAbsolute(offset)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return candidate;
};

export const workspaceRelative = (workspace: string, absolute: string): string =>
  relative(resolve(workspace), absolute).split(sep).join("/");

export const readWorkspaceText = async (
  workspace: string,
  inputPath: string
): Promise<{ absolute: string; content: string; relative: string }> => {
  const absolute = resolveUnderWorkspace(workspace, inputPath);
  const content = await readFile(absolute, "utf8");
  return {
    absolute,
    content,
    relative: workspaceRelative(workspace, absolute),
  };
};

export const writeWorkspaceText = async (
  workspace: string,
  inputPath: string,
  content: string
): Promise<string> => {
  const absolute = resolveUnderWorkspace(workspace, inputPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return workspaceRelative(workspace, absolute);
};
