export const colors = {
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  brightBlue: "\x1b[94m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
  brightMagenta: "\x1b[95m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
} as const;

export function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}
