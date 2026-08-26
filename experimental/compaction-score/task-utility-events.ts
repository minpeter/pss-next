export function taskUtilityAssistantOutput(events: readonly unknown[]): string {
  const deltas: string[] = [];
  const completed: string[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null || !("type" in event)) {
      continue;
    }
    const text = Reflect.get(event, "text");
    const type = Reflect.get(event, "type");
    if (typeof text !== "string") {
      continue;
    }
    if (type === "assistant-output-delta") {
      deltas.push(text);
    } else if (type === "assistant-output") {
      completed.push(text);
    }
  }
  return (deltas.length > 0 ? deltas : completed).join("");
}
