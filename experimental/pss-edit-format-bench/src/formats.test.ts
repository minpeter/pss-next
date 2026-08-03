import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { grokFormat, ompFormat, ompJsonFormat, pssFormat } from "./formats";
import { EDIT_TASKS } from "./tasks";

const taskById = (id: string) => {
  const task = EDIT_TASKS.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(`Unknown task: ${id}`);
  }
  return task;
};

const anchorOf = (rendered: string, lineNumber: number): string => {
  const match = new RegExp(`^(${lineNumber}#[A-Z]{2})\\|`, "mu").exec(rendered);
  if (match === null) {
    throw new Error(`No anchor for line ${lineNumber}`);
  }
  return match[1] as string;
};

describe("pss-json adapter", () => {
  it("applies a single-line replace addressed by target", () => {
    const task = taskById("single-line-to-two");
    const anchor = anchorOf(pssFormat.render(task.path, task.initial).user, 2);
    const reply = JSON.stringify({
      path: task.path,
      edits: [
        {
          new_content: ['    greeting = "Hi"', '    msg = f"{greeting}, {name}"'],
          op: "replace",
          target: anchor,
        },
      ],
    });

    expect(pssFormat.apply(reply, task.initial).text).toBe(task.expected);
  });

  it("applies an inclusive range replace addressed by first and last", () => {
    const task = taskById("delete-middle-line");
    const rendered = pssFormat.render(task.path, task.initial).user;
    // Lines 2-3 collapse to just the print, dropping the msg assignment.
    const reply = JSON.stringify({
      path: task.path,
      edits: [
        {
          first: anchorOf(rendered, 2),
          last: anchorOf(rendered, 3),
          new_content: ["    print(msg)"],
          op: "replace",
        },
      ],
    });

    expect(pssFormat.apply(reply, task.initial).text).toBe(task.expected);
  });

  it("reports the malformed shapes instead of silently editing", () => {
    const task = taskById("single-line-to-two");
    const anchor = anchorOf(pssFormat.render(task.path, task.initial).user, 2);

    for (const edit of [
      { last: anchor, new_content: ["x"], op: "replace" },
      { first: anchor, new_content: ["x"], op: "replace" },
      { first: anchor, last: anchor, new_content: ["x"], op: "replace", target: anchor },
      { new_content: [], op: "replace", target: anchor },
      { new_content: ["x"], op: "replace" },
    ]) {
      const outcome = pssFormat.apply(
        JSON.stringify({ path: task.path, edits: [edit] }),
        task.initial
      );
      expect(outcome.text).toBeUndefined();
      expect(outcome.error).toBeTruthy();
    }
  });

  it("rejects an anchor the file never displayed", () => {
    const task = taskById("single-line-to-two");
    const outcome = pssFormat.apply(
      JSON.stringify({
        path: task.path,
        edits: [{ new_content: ["x"], op: "replace", target: "99#ZZ" }],
      }),
      task.initial
    );

    expect(outcome.error).toMatch(/outside the file/u);
  });

  it("strips provider tool-call XML wrappers before parsing", () => {
    const task = taskById("single-line-to-two");
    const anchor = anchorOf(pssFormat.render(task.path, task.initial).user, 2);
    const payload = JSON.stringify({
      path: task.path,
      edits: [
        {
          new_content: ['    greeting = "Hi"', '    msg = f"{greeting}, {name}"'],
          op: "replace",
          target: anchor,
        },
      ],
    });
    const reply = [
      payload,
      "<minimax:tool_call>",
      '<invoke name="pss-json">',
      '<parameter name="payload">',
      payload,
      "</parameter>",
      "</invoke>",
      "</minimax:tool_call>",
    ].join("\n");

    const outcome = pssFormat.apply(reply, task.initial);
    expect(outcome.error).toBeUndefined();
    expect(outcome.text).toBe(task.expected);
  });
});

describe("omp-dsl adapter", () => {
  it("applies SWAP over an inclusive range", () => {
    const task = taskById("single-line-to-two");
    const reply = `[greet.py#A1B2]\nSWAP 2.=2:\n+    greeting = "Hi"\n+    msg = f"{greeting}, {name}"\n`;

    expect(ompFormat.apply(reply, task.initial).text).toBe(task.expected);
  });

  it("applies DEL without a body", () => {
    const task = taskById("delete-middle-line");
    const reply = "[greet.py#A1B2]\nDEL 2\n";

    expect(ompFormat.apply(reply, task.initial).text).toBe(task.expected);
  });

  it("applies INS.HEAD and INS.TAIL", () => {
    const prepend = taskById("prepend-header");
    expect(
      ompFormat.apply("[greet.py#A1B2]\nINS.HEAD:\n+# generated header\n", prepend.initial).text
    ).toBe(prepend.expected);

    const append = taskById("append-call");
    expect(
      ompFormat.apply('[greet.py#A1B2]\nINS.TAIL:\n+greet("everyone")\n', append.initial).text
    ).toBe(append.expected);
  });

  it("reports a reply carrying no hashline operation", () => {
    const task = taskById("single-line-to-two");
    const outcome = ompFormat.apply("I would change line 2.", task.initial);

    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toBeTruthy();
  });
});

describe("task fixtures", () => {
  it("keeps every task reachable by both formats", () => {
    for (const task of EDIT_TASKS) {
      expect(task.expected).not.toBe(task.initial);
      expect(pssFormat.render(task.path, task.initial).user).toContain("#");
      expect(ompFormat.render(task.path, task.initial).user).toContain(`[${task.path}#`);
    }
  });
});

describe("pss-json mirrors the real edit_file tool", () => {
  const fixture = () => taskById("single-line-to-two");
  const anchorAt = (lineNumber: number): string =>
    anchorOf(pssFormat.render(fixture().path, fixture().initial).user, lineNumber);

  it("renders the read_file surface with file_hash and lines range", () => {
    const task = fixture();
    const rendered = pssFormat.render(task.path, task.initial).user;
    const lineCount = task.initial.replace(/\n$/u, "").split("\n").length;
    expect(rendered).toContain("OK - file");
    expect(rendered).toContain(`path: ${task.path}`);
    expect(rendered).toMatch(/file_hash: [0-9a-f]{8}/u);
    expect(rendered).toContain(`lines: 1-${lineCount}/${lineCount}`);
  });

  it("derives the file_hash with the same SHA-256 hash as hashline.ts", () => {
    const task = fixture();
    const expected = createHash("sha256")
      .update(task.initial)
      .digest()
      .readUInt32BE(0)
      .toString(16)
      .padStart(8, "0");
    expect(pssFormat.render(task.path, task.initial).user).toContain(
      `file_hash: ${expected}`
    );
  });

  it("derives line anchors with the hashline SHA-256 scheme", () => {
    const task = fixture();
    const lines = task.initial.replace(/\n$/u, "").split("\n");
    const nibbles = "ZPMQVRWSNKTXJBYH";
    const dictionary = Array.from({ length: 256 }, (_, value) => {
      const high = Math.floor(value / 16);
      const low = value % 16;
      return `${nibbles[high]}${nibbles[low]}`;
    });
    const lineNumber = 2;
    const line = lines[lineNumber - 1] as string;
    const stripped = line.replace(/\s+/g, "");
    const seed = /[\p{L}\p{N}]/u.test(stripped) ? 0 : lineNumber;
    const hash = createHash("sha256")
      .update(`${seed}:${stripped}`)
      .digest()
      .readUInt32BE(0);
    const expected = `${lineNumber}#${dictionary[hash % 256]}`;
    expect(pssFormat.render(task.path, task.initial).user).toContain(
      `${expected}|`
    );
  });

  it("accepts the matching expected_file_hash and rejects a stale one", () => {
    const task = fixture();
    const anchor = anchorAt(2);
    const call = {
      path: task.path,
      edits: [
        {
          op: "replace",
          target: anchor,
          new_content: ['    greeting = "Hi"', '    msg = f"{greeting}, {name}"'],
        },
      ],
    };
    const stale = pssFormat.apply(
      JSON.stringify({ ...call, expected_file_hash: "00000000" }),
      task.initial
    );
    expect(stale.error).toMatch(/Stale file hash/u);

    const hash = createHash("sha256")
      .update(task.initial)
      .digest()
      .readUInt32BE(0)
      .toString(16)
      .padStart(8, "0");
    const clean = pssFormat.apply(
      JSON.stringify({ ...call, expected_file_hash: hash }),
      task.initial
    );
    expect(clean.error).toBeUndefined();
    expect(clean.text).toBe(task.expected);
  });

  it("rejects a stale anchor the file never showed for that line", () => {
    const task = fixture();
    const outcome = pssFormat.apply(
      JSON.stringify({
        path: task.path,
        edits: [{ new_content: ["x"], op: "replace", target: "2#ZZ" }],
      }),
      task.initial
    );

    expect(outcome.error).toMatch(/Stale anchor/u);
  });

  it("accepts new_content as a single newline-joined string", () => {
    const task = fixture();
    const outcome = pssFormat.apply(
      JSON.stringify({
        path: task.path,
        edits: [
          {
            op: "replace",
            target: anchorAt(2),
            new_content: '    greeting = "Hi"\n    msg = f"{greeting}, {name}"',
          },
        ],
      }),
      task.initial
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.text).toBe(task.expected);
  });

  it("appends and prepends at file edges without a target", () => {
    const append = taskById("append-call");
    expect(
      pssFormat.apply(
        JSON.stringify({
          path: append.path,
          edits: [{ op: "append", new_content: ['greet("everyone")'] }],
        }),
        append.initial
      ).text
    ).toBe(append.expected);

    const prepend = taskById("prepend-header");
    expect(
      pssFormat.apply(
        JSON.stringify({
          path: prepend.path,
          edits: [{ op: "prepend", new_content: ["# generated header"] }],
        }),
        prepend.initial
      ).text
    ).toBe(prepend.expected);
  });

  it("rejects the op values the real tool does not have", () => {
    const task = fixture();
    const anchor = anchorAt(2);
    const outcome = pssFormat.apply(
      JSON.stringify({
        path: task.path,
        edits: [{ new_content: ["x"], op: "delete", target: anchor }],
      }),
      task.initial
    );

    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toBeTruthy();
  });

  it("rejects unknown keys as the strict tool schema does", () => {
    const task = fixture();
    const outcome = pssFormat.apply(
      JSON.stringify({
        path: task.path,
        extra: true,
        edits: [{ op: "append", new_content: ["x"] }],
      }),
      task.initial
    );

    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toBeTruthy();
  });
});

/**
 * Independent reimplementation of grok-build's anchor scheme, derived from the
 * Rust source rather than from `formats.ts`, so the adapter is checked against
 * the spec instead of against itself.
 *
 * crates/codegen/xai-grok-tools/src/util/hash.rs (fnv1a_32, line_hash,
 * encode_hash) and .../grok_build_hashline/scheme.rs (ChunkFingerprint,
 * DEFAULT_HASH_LEN = 3, DEFAULT_CHUNK_SIZE = 16).
 */
const expectedGrokAnchor = (
  lines: readonly string[],
  lineIndex: number
): string => {
  const FNV_OFFSET = 2_166_136_261;
  const FNV_PRIME = 16_777_619;
  const step = (hash: number, byte: number): number =>
    Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  const normalizedHash = (text: string): number => {
    let hash = FNV_OFFSET;
    let previousWasSpace = false;
    for (const byte of new TextEncoder().encode(text.trim())) {
      const isSpace = byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
      if (isSpace) {
        if (!previousWasSpace) {
          hash = step(hash, 0x20);
          previousWasSpace = true;
        }
        continue;
      }
      hash = step(hash, byte);
      previousWasSpace = false;
    }
    return hash;
  };
  const encode = (hash: number, length: number): string => {
    let out = "";
    for (let index = 0; index < length; index += 1) {
      out += String.fromCodePoint((((hash >>> (index * 8)) % 26) + 0x61));
    }
    return out;
  };
  const CHUNK = 16;
  const local = encode(normalizedHash(lines[lineIndex] as string), 3);
  const chunkStart = Math.floor(lineIndex / CHUNK) * CHUNK;
  let chunk = FNV_OFFSET;
  for (const line of lines.slice(chunkStart, chunkStart + CHUNK)) {
    for (const byte of new TextEncoder().encode(line.trim())) {
      chunk = step(chunk, byte);
    }
    chunk = step(chunk, 0x0a);
  }
  return `${lineIndex + 1}:${local}:${encode(chunk, 3)}`;
};

const grokAnchorOf = (rendered: string, lineNumber: number): string => {
  const match = new RegExp(`^(${lineNumber}:[a-z]+:[a-z]+)\u2192`, "mu").exec(
    rendered
  );
  if (match === null) {
    throw new Error(`No grok anchor for line ${lineNumber}`);
  }
  return match[1] as string;
};

describe("grok-json adapter", () => {
  it("renders ANCHOR->CONTENT lines matching the scheme recomputed from the Rust source", () => {
    const task = taskById("while-to-for-range");
    const rendered = grokFormat.render(task.path, task.initial).user;
    const lines = task.initial.replace(/\n$/u, "").split("\n");

    for (const [index, line] of lines.entries()) {
      expect(rendered).toContain(
        `${expectedGrokAnchor(lines, index)}\u2192${line}`
      );
    }
  });

  it("applies a range replace whose content is one newline-joined string", () => {
    const task = taskById("while-to-for-range");
    const rendered = grokFormat.render(task.path, task.initial).user;
    const reply = JSON.stringify({
      edits: [
        {
          anchor: grokAnchorOf(rendered, 4),
          content: [
            "  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {",
            "    const response = await fetch(url);",
            "    if (response.ok) {",
            "      return response;",
            "    }",
            "  }",
          ].join("\n"),
          end_anchor: grokAnchorOf(rendered, 11),
          op: "replace",
        },
      ],
    });

    const outcome = grokFormat.apply(reply, task.initial);
    expect(outcome.error).toBeUndefined();
    expect(outcome.text).toBe(task.expected);
  });

  it("treats an empty replace content as a delete", () => {
    const task = taskById("delete-middle-line");
    const rendered = grokFormat.render(task.path, task.initial).user;
    const reply = JSON.stringify({
      edits: [{ anchor: grokAnchorOf(rendered, 2), content: "", op: "replace" }],
    });

    expect(grokFormat.apply(reply, task.initial).text).toBe(task.expected);
  });

  it("inserts at BOF and EOF through the sentinel anchors", () => {
    const prepend = taskById("prepend-header");
    expect(
      grokFormat.apply(
        JSON.stringify({
          edits: [
            { anchor: "0:", content: "# generated header", op: "insert_after" },
          ],
        }),
        prepend.initial
      ).text
    ).toBe(prepend.expected);

    const append = taskById("append-call");
    expect(
      grokFormat.apply(
        JSON.stringify({
          edits: [
            { anchor: "EOF", content: 'greet("everyone")', op: "insert_after" },
          ],
        }),
        append.initial
      ).text
    ).toBe(append.expected);
  });

  it("rejects a stale anchor and a reversed range", () => {
    const task = taskById("while-to-for-range");
    const rendered = grokFormat.render(task.path, task.initial).user;

    const stale = grokFormat.apply(
      JSON.stringify({
        edits: [{ anchor: "5:zzz:zzz", content: "x", op: "replace" }],
      }),
      task.initial
    );
    expect(stale.text).toBeUndefined();
    expect(stale.error).toBeTruthy();

    const reversed = grokFormat.apply(
      JSON.stringify({
        edits: [
          {
            anchor: grokAnchorOf(rendered, 11),
            content: "x",
            end_anchor: grokAnchorOf(rendered, 5),
            op: "replace",
          },
        ],
      }),
      task.initial
    );
    expect(reversed.error).toMatch(/before/u);
  });
});

describe("grok-json documented tolerances", () => {
  const task = () => taskById("delete-middle-line");
  const singleDelete = (anchor: string) => ({
    anchor,
    content: "",
    op: "replace",
  });

  it("accepts a string-wrapped edits value and counts the tolerance", () => {
    const fixture = task();
    const anchor = grokAnchorOf(
      grokFormat.render(fixture.path, fixture.initial).user,
      2
    );
    const outcome = grokFormat.apply(
      JSON.stringify({ edits: JSON.stringify([singleDelete(anchor)]) }),
      fixture.initial
    );

    expect(outcome.text).toBe(fixture.expected);
    expect(outcome.tolerances).toContain("string-wrapped-edits");
  });

  it("accepts a bare edits object and counts the tolerance", () => {
    const fixture = task();
    const anchor = grokAnchorOf(
      grokFormat.render(fixture.path, fixture.initial).user,
      2
    );
    const outcome = grokFormat.apply(
      JSON.stringify({ edits: singleDelete(anchor) }),
      fixture.initial
    );

    expect(outcome.text).toBe(fixture.expected);
    expect(outcome.tolerances).toContain("bare-edits-object");
  });

  it("recovers an anchor missing its line number and counts the tolerance", () => {
    const fixture = task();
    const anchor = grokAnchorOf(
      grokFormat.render(fixture.path, fixture.initial).user,
      2
    );
    const suffixOnly = anchor.slice(anchor.indexOf(":") + 1);
    const outcome = grokFormat.apply(
      JSON.stringify({ edits: [singleDelete(suffixOnly)] }),
      fixture.initial
    );

    expect(outcome.text).toBe(fixture.expected);
    expect(outcome.tolerances).toContain("suffix-recovered-anchor");
  });

  it("strips a pasted arrow separator and counts the tolerance", () => {
    const fixture = task();
    const anchor = grokAnchorOf(
      grokFormat.render(fixture.path, fixture.initial).user,
      2
    );
    const outcome = grokFormat.apply(
      JSON.stringify({
        edits: [singleDelete(`${anchor}\u2192    msg = "Hello, " + name`)],
      }),
      fixture.initial
    );

    expect(outcome.text).toBe(fixture.expected);
    expect(outcome.tolerances).toContain("arrow-stripped-anchor");
  });

  it("reports no tolerance for a well-formed call", () => {
    const fixture = task();
    const anchor = grokAnchorOf(
      grokFormat.render(fixture.path, fixture.initial).user,
      2
    );
    const outcome = grokFormat.apply(
      JSON.stringify({ edits: [singleDelete(anchor)] }),
      fixture.initial
    );

    expect(outcome.text).toBe(fixture.expected);
    expect(outcome.tolerances ?? []).toHaveLength(0);
  });
});

describe("omp-json adapter", () => {
  it("renders the same file surface as omp-dsl", () => {
    const task = taskById("single-line-to-two");
    const rendered = ompJsonFormat.render(task.path, task.initial).user;
    expect(rendered).toContain(`[${task.path}#A1B2]`);
    expect(rendered).toContain('2:    msg = "Hello, " + name');
  });

  it("applies a single-line swap addressed by first and last", () => {
    const task = taskById("single-line-to-two");
    const reply = JSON.stringify({
      file_path: task.path,
      tag: "A1B2",
      hunks: [
        {
          op: "swap",
          first: 2,
          last: 2,
          content: '    greeting = "Hi"\n    msg = f"{greeting}, {name}"',
        },
      ],
    });

    expect(ompJsonFormat.apply(reply, task.initial).text).toBe(task.expected);
  });

  it("applies a block swap through the resolver path", () => {
    const task = taskById("while-to-for-range");
    const reply = JSON.stringify({
      file_path: task.path,
      tag: "A1B2",
      hunks: [
        {
          op: "swap_block",
          line: 5,
          content: [
            "  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {",
            "    const response = await fetch(url);",
            "    if (response.ok) {",
            "      return response;",
            "    }",
            "  }",
          ].join("\n"),
        },
      ],
    });

    // The while block spans lines 5-11; line 4 (`let attempt`) is outside the
    // block and must survive.
    const lines = task.initial.replace(/\n$/u, "").split("\n");
    const expected = [...lines.slice(0, 4), ...reply.includes("for") ? [
      "  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {",
      "    const response = await fetch(url);",
      "    if (response.ok) {",
      "      return response;",
      "    }",
      "  }",
    ] : [], ...lines.slice(11)].join("\n") + "\n";

    expect(ompJsonFormat.apply(reply, task.initial).text).toBe(expected);
  });

  it("applies edge inserts and a delete", () => {
    const prepend = taskById("prepend-header");
    expect(
      ompJsonFormat.apply(
        JSON.stringify({
          file_path: prepend.path,
          tag: "A1B2",
          hunks: [{ op: "insert_head", content: "# generated header" }],
        }),
        prepend.initial
      ).text
    ).toBe(prepend.expected);

    const append = taskById("append-call");
    expect(
      ompJsonFormat.apply(
        JSON.stringify({
          file_path: append.path,
          tag: "A1B2",
          hunks: [{ op: "insert_tail", content: 'greet("everyone")' }],
        }),
        append.initial
      ).text
    ).toBe(append.expected);

    const del = taskById("delete-middle-line");
    expect(
      ompJsonFormat.apply(
        JSON.stringify({
          file_path: del.path,
          tag: "A1B2",
          hunks: [{ op: "delete", first: 2, last: 2 }],
        }),
        del.initial
      ).text
    ).toBe(del.expected);
  });

  it("applies insert_post and a block delete", () => {
    const task = taskById("while-to-for-range");
    const reply = JSON.stringify({
      file_path: task.path,
      tag: "A1B2",
      hunks: [
        { op: "insert_post", line: 4, content: "  // setup" },
        { op: "delete_block", line: 5 },
      ],
    });

    // delete_block removes the while block (5-11); the insert lands after
    // original line 4.
    const lines = task.initial.replace(/\n$/u, "").split("\n");
    const expected = [
      ...lines.slice(0, 4),
      "  // setup",
      ...lines.slice(11),
    ].join("\n") + "\n";

    expect(ompJsonFormat.apply(reply, task.initial).text).toBe(expected);
  });

  it("rejects delete carrying content", () => {
    const task = taskById("delete-middle-line");
    const outcome = ompJsonFormat.apply(
      JSON.stringify({
        file_path: task.path,
        tag: "A1B2",
        hunks: [{ op: "delete", first: 2, last: 2, content: "x" }],
      }),
      task.initial
    );

    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toMatch(/delete does not take content/u);
  });

  it("rejects a swap missing its range end", () => {
    const task = taskById("single-line-to-two");
    const outcome = ompJsonFormat.apply(
      JSON.stringify({
        file_path: task.path,
        tag: "A1B2",
        hunks: [{ op: "swap", first: 2, content: "x" }],
      }),
      task.initial
    );

    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toMatch(/swap requires last/u);
  });

  it("rejects an edge insert carrying a line number", () => {
    const task = taskById("prepend-header");
    const outcome = ompJsonFormat.apply(
      JSON.stringify({
        file_path: task.path,
        tag: "A1B2",
        hunks: [{ op: "insert_head", line: 1, content: "x" }],
      }),
      task.initial
    );

    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toMatch(/insert_head does not take line/u);
  });

  it("rejects an empty swap body and points at delete", () => {
    const task = taskById("delete-middle-line");
    const outcome = ompJsonFormat.apply(
      JSON.stringify({
        file_path: task.path,
        tag: "A1B2",
        hunks: [{ op: "swap", first: 2, last: 2, content: "" }],
      }),
      task.initial
    );

    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toMatch(/delete/u);
  });
});
