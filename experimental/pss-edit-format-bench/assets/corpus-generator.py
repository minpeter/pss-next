import json
import random
import re
import difflib
import hashlib
import os
import math

rng = random.Random(42)

PLS = {
    "py": lambda i: [f"def fn_{i}(arg_{i}):", f"    return arg_{i} * {i % 9 + 2}"],
    "js": lambda i: [f"function fn_{i}(arg_{i}) {{", f"  return arg_{i} * {i % 9 + 2};", "}"],
    "ts": lambda i: [f"export function fn_{i}(arg_{i}: number): number {{", f"  return arg_{i} * {i % 9 + 2};", "}"],
    "go": lambda i: [f"func fn_{i}(arg_{i} int) int {{", f"\treturn arg_{i} * {i % 9 + 2}", "}"],
    "rs": lambda i: [f"fn fn_{i}(arg_{i}: i32) -> i32 {{", f"    arg_{i} * {i % 9 + 2}", "}"],
    "java": lambda i: [f"int fn_{i}(int arg_{i}) {{ return arg_{i} * {i % 9 + 2}; }}"],
    "c": lambda i: [f"int fn_{i}(int arg_{i}) {{ return arg_{i} * {i % 9 + 2}; }}"],
    "cpp": lambda i: [f"auto fn_{i}(int arg_{i}) {{ return arg_{i} * {i % 9 + 2}; }}"],
    "kt": lambda i: [f"fun fn_{i}(arg_{i}: Int): Int {{ return arg_{i} * {i % 9 + 2} }}"],
    "rb": lambda i: [f"def fn_{i}(arg_{i})", f"  arg_{i} * {i % 9 + 2}", "end"],
}
COMMENT = {"py": "# note", "js": "// note", "ts": "// note", "go": "// note",
           "rs": "// note", "java": "// note", "c": "/* note */", "cpp": "// note",
           "kt": "// note", "rb": "# note"}
ASSIGN = {
    "py": lambda i: f"val_{i} = {i * 3}",
    "js": lambda i: f"const val_{i} = {i * 3};",
    "ts": lambda i: f"const val_{i}: number = {i * 3};",
    "go": lambda i: f"var val_{i} = {i * 3}",
    "rs": lambda i: f"let val_{i} = {i * 3};",
    "java": lambda i: f"int val_{i} = {i * 3};",
    "c": lambda i: f"int val_{i} = {i * 3};",
    "cpp": lambda i: f"auto val_{i} = {i * 3};",
    "kt": lambda i: f"val val_{i} = {i * 3}",
    "rb": lambda i: f"val_{i} = {i * 3}",
}
BLOCK_OPEN = {"py": "def core():", "js": "function core() {", "ts": "function core(): void {",
              "go": "func core() {", "rs": "fn core() {", "java": "void core() {",
              "c": "void core() {", "cpp": "void core() {", "kt": "fun core() {", "rb": "def core"}
BLOCK_BODY = {"py": "    return 1", "js": "  return 1;", "ts": "  return 1;", "go": "\treturn 1",
              "rs": "    1", "java": "  return 1;", "c": "  return 1;", "cpp": "  return 1;",
              "kt": "  return 1", "rb": "  1"}
BLOCK_CLOSE = {"py": "", "js": "}", "ts": "}", "go": "}", "rs": "}", "java": "}",
               "c": "}", "cpp": "}", "kt": "}", "rb": "end"}

def make_file(lang, size):
    lines = []
    if lang in ("go", "java", "c", "cpp", "kt", "rb"):
        if lang in ("go", "c"):
            lines.append("package main" if lang == "go" else "#include <stdio.h>")
        elif lang in ("java", "kt"):
            lines.append("public class Main {")
        elif lang == "cpp":
            lines.append("#include <cstdint>")
    idx = 0
    while len(lines) < size - 2:
        kind = rng.random()
        if kind < 0.35:
            lines.extend(ASSIGN[lang](idx))
            idx += 1
        elif kind < 0.6:
            lines.extend(PLS[lang](idx))
            idx += 1
        elif kind < 0.75:
            lines.append(COMMENT[lang])
        elif kind < 0.9:
            lines.append("")
        else:
            lines.extend(PLS[lang](idx))
            idx += 1
    body = [BLOCK_BODY[lang]] if BLOCK_BODY[lang] else []
    core = [BLOCK_OPEN[lang]] + body + ([BLOCK_CLOSE[lang]] if BLOCK_CLOSE[lang] else [])
    lines = core + lines
    if lang in ("java", "kt"):
        lines.append("}")
    lines = lines[:size]
    return "\n".join(lines) + "\n"

def apply_edit(initial, op):
    lines = initial.split("\n")
    if initial.endswith("\n"):
        lines = lines[:-1]
    if op["kind"] == "replace-line":
        i = op["at"]
        lines[i] = op["new"][0]
        return "\n".join(lines) + "\n"
    if op["kind"] == "replace-range":
        a, b = op["a"], op["b"]
        return "\n".join(lines[:a] + op["new"] + lines[b + 1:]) + "\n"
    if op["kind"] == "insert":
        pos = op["at"]
        return "\n".join(lines[:pos] + op["new"] + lines[pos:]) + "\n"
    if op["kind"] == "delete":
        a, b = op["a"], op["b"]
        return "\n".join(lines[:a] + lines[b + 1:]) + "\n"
    if op["kind"] == "rename":
        return re.sub(r"\bcore\b", op["to"], initial)
    if op["kind"] == "multi-hunk":
        for e in op["edits"]:
            if e["kind"] == "replace-line":
                lines[e["at"]] = e["new"][0]
            elif e["kind"] == "delete":
                a, b = e["a"], e["b"]
                del lines[a:b + 1]
                e["b"] = e["a"] - 1
        return "\n".join(lines) + "\n"
    raise ValueError(op["kind"])

def random_edit(lines, lang):
    n = len(lines)
    kind = rng.random()
    if kind < 0.25:
        i = rng.randrange(n)
        return {"kind": "replace-line", "at": i, "new": [f"val_r{abs(hash((i, lang))) % 1000} = {rng.randrange(100)}"]}
    if kind < 0.45:
        a = rng.randrange(n - 1)
        b = min(n - 1, a + rng.randrange(1, 6))
        return {"kind": "replace-range", "a": a, "b": b,
                "new": [f"val_r{rng.randrange(1000)} = {rng.randrange(100)}"] * rng.randrange(1, 4)}
    if kind < 0.65:
        pos = rng.randrange(n + 1)
        return {"kind": "insert", "at": pos,
                "new": [f"val_r{rng.randrange(1000)} = {rng.randrange(100)}"] * rng.randrange(1, 4)}
    if kind < 0.8:
        a = rng.randrange(n - 1)
        b = min(n - 1, a + rng.randrange(0, 4))
        return {"kind": "delete", "a": a, "b": b}
    if kind < 0.9:
        return {"kind": "rename", "to": f"core_{rng.randrange(1000)}"}
    e1 = {"kind": "replace-line", "at": rng.randrange(n // 2), "new": ["x1 = 1"]}
    e2 = {"kind": "delete", "a": n // 2 + rng.randrange(1, max(2, n - n // 2)), "b": 0}
    return {"kind": "multi-hunk", "edits": [e1, e2]}

NIBBLES = "ZPMQVRWSNKTXJBYH"

def u32(s):
    return int.from_bytes(hashlib.sha256(s.encode("utf-8")).digest()[:4], "big")

def line_id(no, content):
    stripped = re.sub(r"\s+", "", content)
    seed = 0 if any(ch.isalnum() for ch in stripped) else no
    h = u32(f"{seed}:{stripped}") % 256
    return NIBBLES[h // 16] + NIBBLES[h % 16]

def file_hash(content):
    return f"{u32(content):08x}"

def pss_render(path, text):
    lines = text.split("\n")
    if text.endswith("\n"):
        lines = lines[:-1]
    body = "\n".join(f"{i + 1}#{line_id(i + 1, l)}|{l}" for i, l in enumerate(lines))
    rng_line = "0/0" if not lines else f"1-{len(lines)}/{len(lines)}"
    return f"OK - file\npath: {path}\nfile_hash: {file_hash(text)}\nlines: {rng_line}\n{body}"

def omp_render(path, text):
    lines = text.split("\n")
    if text.endswith("\n"):
        lines = lines[:-1]
    return f"[{path}#A1B2]\n" + "\n".join(f"{i + 1}:{l}" for i, l in enumerate(lines))

FNV_OFF = 2166136261
FNV_P = 16777619

def grok_step(h, b):
    return ((h ^ b) * FNV_P) & 0xFFFFFFFF

def grok_line_hash(line):
    h = FNV_OFF
    prev_space = False
    for byte in line.strip().encode("utf-8"):
        is_space = byte == 0x20 or (0x09 <= byte <= 0x0D)
        if is_space:
            if not prev_space:
                h = grok_step(h, 0x20)
                prev_space = True
            continue
        h = grok_step(h, byte)
        prev_space = False
    return h

def grok_encode(h, length):
    return "".join(chr(((h >> (i * 8)) % 26) + 0x61) for i in range(length))

def grok_anchor(lines, index):
    local = grok_encode(grok_line_hash(lines[index]), 3)
    start = (index // 16) * 16
    chunk = FNV_OFF
    for line in lines[start:start + 16]:
        for byte in line.strip().encode("utf-8"):
            chunk = grok_step(chunk, byte)
        chunk = grok_step(chunk, 0x0A)
    return f"{index + 1}:{local}:{grok_encode(chunk, 3)}"

def grok_render(path, text):
    lines = text.split("\n")
    if text.endswith("\n"):
        lines = lines[:-1]
    body = "\n".join(f"{grok_anchor(lines, i)}\u2192{l}" for i, l in enumerate(lines))
    return f"File {path}:\n{body}"

def split(text):
    lines = text.split("\n")
    if text.endswith("\n"):
        lines = lines[:-1]
    return lines

def omp_reply(path, initial, expected):
    a, b = split(initial), split(expected)
    rows = [f"[{path}#A1B2]"]
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace":
            rows.append(f"SWAP {i1 + 1}.={i2}:")
            rows.extend(f"+{l}" for l in b[j1:j2])
        elif tag == "delete":
            rows.append(f"DEL {i1 + 1}.={i2}")
        elif tag == "insert":
            if i1 == 0:
                rows.append("INS.HEAD:")
            elif i1 == len(a):
                rows.append("INS.TAIL:")
            else:
                rows.append(f"INS.PRE {i1 + 1}:")
            rows.extend(f"+{l}" for l in b[j1:j2])
    return "\n".join(rows)

def sr_reply(initial, expected):
    a, b = split(initial), split(expected)
    parts = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes():
        if tag == "equal":
            continue
        parts.append("<<<<<<< SEARCH")
        parts.extend(a[i1:i2] or [""])
        parts.append("=======")
        parts.extend(b[j1:j2])
        parts.append(">>>>>>> REPLACE")
    return "\n".join(parts)

def udiff_reply(path, initial, expected):
    return "".join(difflib.unified_diff(initial.splitlines(True), expected.splitlines(True),
                                        fromfile=path, tofile=path, n=0))

def pss_reply(path, initial, expected):
    anchors = {i + 1: f"{i + 1}#{line_id(i + 1, l)}" for i, l in enumerate(split(initial))}
    a, b = split(initial), split(expected)
    edits = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes():
        if tag == "equal":
            continue
        body = b[j1:j2]
        if tag == "replace":
            if len(body) == 1 and i2 - i1 == 1:
                edits.append({"op": "replace", "target": anchors.get(i1 + 1), "new_content": body})
            else:
                edits.append({"op": "replace", "first": anchors.get(i1 + 1), "last": anchors.get(i2), "new_content": body or [""]})
        elif tag == "delete":
            edits.append({"op": "replace", "first": anchors.get(i1 + 1), "last": anchors.get(i2), "new_content": [""]})
        elif tag == "insert":
            if i1 == 0:
                edits.append({"op": "prepend", "new_content": body})
            elif i1 == len(a):
                edits.append({"op": "append", "new_content": body})
            else:
                edits.append({"op": "append", "target": anchors.get(i1), "new_content": body})
    return json.dumps({"path": path, "edits": edits})

def grok_reply(path, initial, expected):
    anchors = {i: grok_anchor(split(initial), i) for i in range(len(split(initial)))}
    a, b = split(initial), split(expected)
    edits = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes():
        if tag == "equal":
            continue
        body = "\n".join(b[j1:j2])
        if tag == "replace" or tag == "delete":
            edits.append({"op": "replace", "anchor": anchors[i1], "content": body})
        elif tag == "insert":
            edits.append({"op": "insert_after", "anchor": anchors[i1 - 1] if i1 > 0 else "0:", "content": body})
    return json.dumps({"edits": edits})

rows = []
count = 0
for lang in PLS:
    for n in range(20):
        size = max(3, min(200, int(round(math.exp(rng.uniform(math.log(3), math.log(200)))))))
        initial = make_file(lang, size)
        lines = split(initial)
        op = random_edit(lines, lang)
        expected = apply_edit(initial, op)
        raw = len(initial)
        whole = len(expected)
        sr = len(sr_reply(initial, expected))
        ud = len(udiff_reply(f"f_{count}.{lang}", initial, expected))
        omp = len(omp_reply(f"f_{count}.{lang}", initial, expected))
        pss = len(pss_reply(f"f_{count}.{lang}", initial, expected))
        grk = len(grok_reply(f"f_{count}.{lang}", initial, expected))
        new_body = sum(len(l) + 1 for _, _, _, j1, j2 in difflib.SequenceMatcher(None, lines, split(expected)).get_opcodes()
                       for l in split(expected)[j1:j2] if True)
        block = new_body + 25
        pss_in = len(pss_render(f"f_{count}.{lang}", initial))
        omp_in = len(omp_render(f"f_{count}.{lang}", initial))
        grk_in = len(grok_render(f"f_{count}.{lang}", initial))
        rows.append({
            "id": count, "lang": lang, "lines": len(lines), "raw": raw, "kind": op["kind"],
            "reply": {"whole": whole, "sr": sr, "udiff": ud, "block": block, "omp": omp, "pss": pss, "grok": grk},
            "input": {"raw": raw, "pss": pss_in, "omp": omp_in, "grok": grk_in},
        })
        count += 1

assets = "/home/minpeter/github.com/minpeter/pss-runtime/experimental/pss-edit-format-bench/assets"
with open(os.path.join(assets, "edit-mechanisms-dist-200.json"), "w") as f:
    json.dump({"corpus": {"n": count, "langs": list(PLS), "seed": 42,
                          "size_range": [3, 200], "edit_kinds": sorted({r["kind"] for r in rows})},
               "rows": rows}, f, ensure_ascii=False, indent=1)
print("corpus:", count, "files; langs:", list(PLS))
print("edit kinds:", sorted({r["kind"] for r in rows}))
