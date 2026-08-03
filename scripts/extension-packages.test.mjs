import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageCases = [
  {
    directory: "extensions/latex",
    name: "@minpeter/pss-extension-latex",
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
      expect(manifest.repository.directory).toBe(directory);
      expect(manifest.exports["."].import).toBe("./dist/index.js");
      expect(manifest.exports["."].types).toBe("./dist/index.d.ts");
    }
  );
});
