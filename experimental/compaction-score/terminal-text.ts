const TERMINAL_ACTIVE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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
