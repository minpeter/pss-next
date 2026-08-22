import type { ModelMessage } from "ai";
import type { UserInput } from "../input/input";
import { userInputToModelMessage } from "../protocol/mapping";
import { compactionContextMessage, type ThreadContextMessage } from "./context";
import {
  type ThreadCompactionRecord,
  validateModelMessage,
  validateThreadCompactionRecord,
} from "./snapshot";

export class ModelMessageHistory {
  readonly #compactions: ThreadCompactionRecord[] = [];
  readonly #modelHistory: ModelMessage[] = [];
  readonly #onChange?: (snapshot: ModelMessage[]) => void;
  readonly #transientMessages: TransientModelMessage[] = [];

  constructor(
    history?: ModelMessage[],
    onChange?: (snapshot: ModelMessage[]) => void,
    compactions: readonly ThreadCompactionRecord[] = []
  ) {
    if (history) {
      this.#modelHistory = history.map(validateModelMessage);
    }
    this.#compactions = compactions.map((record) =>
      validateThreadCompactionRecord(record, this.#modelHistory.length)
    );
    this.#onChange = onChange;
  }

  modelSnapshot(): ModelMessage[] {
    return structuredClone(this.#modelHistory);
  }

  modelContextSnapshot(
    options: { readonly maxMessages?: number } = {}
  ): ThreadContextMessage[] {
    const compacted = applyCompactions(
      this.#modelHistory,
      this.#compactions,
      this.#transientMessages
    );
    if (
      options.maxMessages === undefined ||
      compacted.length <= options.maxMessages
    ) {
      return compacted;
    }
    return compacted.slice(Math.max(0, compacted.length - options.maxMessages));
  }

  compactionSnapshot(): ThreadCompactionRecord[] {
    return structuredClone(this.#compactions);
  }

  recordCompaction(record: ThreadCompactionRecord): ThreadCompactionRecord {
    const stored = validateThreadCompactionRecord(
      record,
      this.#modelHistory.length
    );
    this.#compactions.push(stored);
    this.#triggerChange();
    return stored;
  }

  removeCompaction(record: ThreadCompactionRecord): void {
    const index = this.#compactions.indexOf(record);
    if (index === -1) {
      return;
    }
    this.#compactions.splice(index, 1);
    this.#triggerChange();
  }

  appendUserInput(input: UserInput): void {
    this.#modelHistory.push(userInputToModelMessage(input));
    this.#triggerChange();
  }

  appendTransientUserInput(input: UserInput): void {
    this.#transientMessages.push({
      index: this.#modelHistory.length,
      message: userInputToModelMessage(input),
    });
  }

  appendModelMessage(message: ModelMessage): void {
    this.#modelHistory.push(validateModelMessage(message));
    this.#triggerChange();
  }

  clearTransientInputs(): void {
    this.#transientMessages.length = 0;
  }

  rollback(snapshot: ModelMessage[]): void {
    this.#modelHistory.length = 0;
    this.#modelHistory.push(...snapshot.map(validateModelMessage));
    this.clearTransientInputs();
    for (let index = this.#compactions.length - 1; index >= 0; index -= 1) {
      const record = this.#compactions[index];
      if (!record || record.endSeqExclusive > this.#modelHistory.length) {
        this.#compactions.splice(index, 1);
      }
    }
    this.#triggerChange();
  }

  #triggerChange(): void {
    this.#onChange?.(this.modelSnapshot());
  }
}

function applyCompactions(
  history: readonly ModelMessage[],
  compactions: readonly ThreadCompactionRecord[],
  transientMessages: readonly TransientModelMessage[] = []
): ThreadContextMessage[] {
  const kept = nonOverlappedCompactions(history.length, compactions);
  if (kept.length === 0) {
    return applyTransientMessages(
      history.map((message) => structuredClone(message)),
      history.length,
      transientMessages
    );
  }

  const byStart = new Map<number, ThreadCompactionRecord>();
  for (const record of kept) {
    byStart.set(record.startSeq, record);
  }

  const output: ThreadContextMessage[] = [];
  for (let index = 0; index < history.length; ) {
    appendTransientMessages(output, transientMessages, index);
    const record = byStart.get(index);
    if (record) {
      output.push(compactionContextMessage(record));
      index = record.endSeqExclusive;
      continue;
    }

    const message = history[index];
    if (message) {
      output.push(structuredClone(message));
    }
    index += 1;
  }
  appendTransientMessages(output, transientMessages, history.length);
  return output;
}

interface TransientModelMessage {
  readonly index: number;
  readonly message: ModelMessage;
}

function applyTransientMessages(
  history: ModelMessage[],
  historyLength: number,
  transientMessages: readonly TransientModelMessage[]
): ModelMessage[] {
  if (transientMessages.length === 0) {
    return history;
  }

  const output: ModelMessage[] = [];
  for (let index = 0; index < historyLength; index += 1) {
    appendTransientMessages(output, transientMessages, index);
    const message = history[index];
    if (message) {
      output.push(message);
    }
  }
  appendTransientMessages(output, transientMessages, historyLength);
  return output;
}

function appendTransientMessages(
  output: ThreadContextMessage[],
  transientMessages: readonly TransientModelMessage[],
  index: number
): void {
  for (const transient of transientMessages) {
    if (transient.index === index) {
      output.push(structuredClone(transient.message));
    }
  }
}

function nonOverlappedCompactions(
  historyLength: number,
  compactions: readonly ThreadCompactionRecord[]
): ThreadCompactionRecord[] {
  const kept: ThreadCompactionRecord[] = [];
  for (let index = compactions.length - 1; index >= 0; index -= 1) {
    const record = compactions[index];
    if (!record || record.endSeqExclusive > historyLength) {
      continue;
    }
    if (kept.some((keptRecord) => overlaps(record, keptRecord))) {
      continue;
    }
    kept.push(record);
  }
  return kept.sort((left, right) => left.startSeq - right.startSeq);
}

function overlaps(
  left: ThreadCompactionRecord,
  right: ThreadCompactionRecord
): boolean {
  return (
    left.startSeq < right.endSeqExclusive &&
    right.startSeq < left.endSeqExclusive
  );
}
