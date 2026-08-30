import type { ProcessQueuedInputOptions } from "./turn-processor-options";

export function restoreContextTokenMeter(
  meter: ProcessQueuedInputOptions["model"]["contextTokenMeter"],
  checkpoint: ReturnType<NonNullable<typeof meter>["checkpoint"]> | undefined,
  run: ProcessQueuedInputOptions["item"]["run"]
): void {
  if (!(meter && checkpoint)) {
    return;
  }
  run.emit({ ...meter.restore(checkpoint), type: "context-usage" });
}
