import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageCases = [
  {
    directory: "extensions/latex",
    name: "@minpeter/pss-extension-latex",
  },
  {
    directory: "extensions/mermaid",
    name: "@minpeter/pss-extension-mermaid",
  },
  {
    directory: "extensions/web",
    name: "@minpeter/pss-extension-web",
  },
];

describe("official extension packages", () => {
  it.each(packageCases)(
    "publishes $name from its own workspace boundary",
    ({ directory, name }) => {
      const manifestPath = `${directory}/package.json`;
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

      expect(manifest.name).toBe(name);
      // Independently installable via `pss extension install`; a private
      // manifest can never be published for the manager to fetch.
      expect(manifest.private).not.toBe(true);
      expect(manifest.repository.directory).toBe(directory);
      expect(manifest.exports["."].import).toBe("./dist/index.js");
      expect(manifest.exports["."].types).toBe("./dist/index.d.ts");
      expect(manifest.files).toContain("dist");
    }
  );
});
