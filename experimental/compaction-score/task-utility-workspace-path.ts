import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export async function validatedTaskWorkspacePath(
  artifactPath: string,
  workspace: string
): Promise<string> {
  const lexicalRoot = resolve(dirname(artifactPath), "workspaces");
  const canonicalRoot = await realpath(lexicalRoot);
  if (canonicalRoot !== lexicalRoot) {
    throw new TypeError("Task utility workspace root must not be a symlink.");
  }
  const target = await realpath(resolve(workspace));
  const child = relative(canonicalRoot, target);
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new TypeError(
      "Task utility workspace is outside the artifact output."
    );
  }
  return target;
}

export async function validatedTaskEvidenceFile(
  workspace: string,
  filename: string
): Promise<string> {
  const lexical = resolve(workspace, filename);
  const canonical = await realpath(lexical);
  if (canonical !== lexical) {
    throw new TypeError("Task utility evidence file must not be a symlink.");
  }
  return canonical;
}
