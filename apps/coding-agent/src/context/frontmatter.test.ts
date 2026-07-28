import { describe, expect, it } from "vitest";
import { parseMarkdownFrontmatter } from "./frontmatter";

describe("parseMarkdownFrontmatter", () => {
  it("returns the whole content when no frontmatter exists", () => {
    const parsed = parseMarkdownFrontmatter("# Title\nbody");
    expect(parsed.body).toBe("# Title\nbody");
    expect(parsed.metadata).toEqual({});
  });

  it("parses simple key/value metadata", () => {
    const parsed = parseMarkdownFrontmatter(
      '---\nname: review\ndescription: "Review the diff"\n---\nBody text'
    );
    expect(parsed.metadata).toEqual({
      description: "Review the diff",
      name: "review",
    });
    expect(parsed.body).toBe("Body text");
  });

  it("treats an unterminated block as plain content", () => {
    const parsed = parseMarkdownFrontmatter("---\nname: x\nno close");
    expect(parsed.body).toBe("---\nname: x\nno close");
    expect(parsed.metadata).toEqual({});
  });

  it("ignores malformed metadata lines and duplicate keys", () => {
    const parsed = parseMarkdownFrontmatter(
      "---\nname: first\nname: second\n!!!bad\n---\nbody"
    );
    expect(parsed.metadata).toEqual({ name: "first" });
  });
});
