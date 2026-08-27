const INLINE_WIDTH = 80;
const ARRAY_PROPERTY_PATTERN = /^(\s+)"[^"]+": \[$/;
const STRING_ITEM_PATTERN = /^\s+"[^"]+"[,]?$/;

export function formatRuntimePublicApiSnapshot(snapshot) {
  const lines = JSON.stringify(snapshot, null, 2).split("\n");
  const formatted = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const start = ARRAY_PROPERTY_PATTERN.exec(line);
    if (start === null) {
      formatted.push(line);
      continue;
    }
    const indentation = start[1];
    const endIndex = lines.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        (candidate === `${indentation}]` || candidate === `${indentation}],`)
    );
    if (endIndex < 0) {
      formatted.push(line);
      continue;
    }
    const items = lines.slice(index + 1, endIndex);
    const candidate = `${line}${items.map((item) => item.trim()).join(" ")}${lines[
      endIndex
    ].trim()}`;
    if (
      candidate.length <= INLINE_WIDTH &&
      items.every((item) => STRING_ITEM_PATTERN.test(item))
    ) {
      formatted.push(candidate);
      index = endIndex;
      continue;
    }
    formatted.push(line);
  }
  return `${formatted.join("\n")}\n`;
}
