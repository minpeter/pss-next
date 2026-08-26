const TERMINAL_ACTIVE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const TERMINAL_ACTIVE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function formatTerminalReportLocation(reportPath: string): string {
  const encodedPath = JSON.stringify(reportPath).replace(
    TERMINAL_ACTIVE_CHARACTERS,
    (character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) {
        throw new TypeError("Terminal character must have a code point.");
      }
      if (codePoint <= 0xff_ff) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      const scalar = codePoint - 0x1_00_00;
      const high = 0xd8_00 + Math.floor(scalar / 0x4_00);
      const low = 0xdc_00 + (scalar % 0x4_00);
      return `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  );
  return `report: ${encodedPath}`;
}

export function isBoundedTerminalText(
  value: unknown,
  maximumLength: number
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff) {
      const trailingCodeUnit = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        trailingCodeUnit < 0xdc_00 ||
        trailingCodeUnit > 0xdf_ff
      ) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff) {
      return false;
    }
  }
  return !TERMINAL_ACTIVE_CHARACTER.test(value);
}
