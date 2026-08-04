import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./bindings";
import type {
  InMemoryDurableObjectSqlState,
  ThreadCompactionRow,
  ThreadInputRow,
  ThreadMessageChunkRow,
  ThreadMetaRow,
} from "./state";

export function writeThreadStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  if (query.startsWith("delete from pss_thread_input")) {
    deleteThreadInputs(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_input")) {
    upsertThreadInput(state, bindings);
    return;
  }
  if (query.startsWith("update pss_thread_input set record = ?")) {
    updateThreadInputRecord(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_thread_compaction")) {
    deleteThreadCompactions(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_compaction")) {
    insertThreadCompaction(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_thread_message_chunk")) {
    deleteThreadMessageChunks(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_message_chunk")) {
    insertThreadMessageChunk(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_thread_message")) {
    deleteThreadMessages(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_thread_meta")) {
    state.threadMeta.delete(stringBinding(bindings[0]));
    return;
  }
  if (query.startsWith("update pss_thread_message set active = 0")) {
    deactivateThreadMessages(state, query, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_message")) {
    insertThreadMessage(state, query, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_meta")) {
    insertThreadMeta(state, bindings);
    return;
  }
  throw new Error(`Unsupported in-memory thread SQL statement: ${query}`);
}

function deleteThreadInputs(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  const threadKey = stringBinding(bindings[1]);
  state.threadInputs = state.threadInputs.filter(
    (row) => !(row.prefix === prefix && row.thread_key === threadKey)
  );
}

function upsertThreadInput(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const existing = state.threadInputs.find(
    (row) =>
      row.prefix === stringBinding(bindings[0]) &&
      row.thread_key === stringBinding(bindings[1]) &&
      row.message_id === stringBinding(bindings[2])
  );
  const row: ThreadInputRow = {
    admitted_at_ms: numberBinding(bindings[8]),
    admitted_seq: numberBinding(bindings[7]),
    claim_id: nullableStringBinding(bindings[9]),
    created_at: existing?.created_at ?? numberBinding(bindings[10]),
    kind: stringBinding(bindings[4]),
    message_id: stringBinding(bindings[2]),
    placement: nullableStringBinding(bindings[5]),
    prefix: stringBinding(bindings[0]),
    record: stringBinding(bindings[3]),
    status: stringBinding(bindings[6]),
    thread_key: stringBinding(bindings[1]),
    updated_at: numberBinding(bindings[11]),
  };
  state.threadInputs = state.threadInputs.filter(
    (current) =>
      !(
        current.prefix === row.prefix &&
        current.thread_key === row.thread_key &&
        current.message_id === row.message_id
      )
  );
  state.threadInputs.push(row);
}

function updateThreadInputRecord(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[1]);
  const threadKey = stringBinding(bindings[2]);
  const messageId = stringBinding(bindings[3]);
  state.threadInputs = state.threadInputs.map((row) =>
    row.prefix === prefix &&
    row.thread_key === threadKey &&
    row.message_id === messageId
      ? { ...row, record: stringBinding(bindings[0]) }
      : row
  );
}

function deleteThreadCompactions(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.threadCompactions = state.threadCompactions.filter(
    (row) => row.thread_key !== key
  );
}

function insertThreadCompaction(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const row: ThreadCompactionRow = {
    end_seq_exclusive: numberBinding(bindings[3]),
    ordinal: numberBinding(bindings[1]),
    start_seq: numberBinding(bindings[2]),
    summary: stringBinding(bindings[4]),
    thread_key: stringBinding(bindings[0]),
  };
  state.threadCompactions = state.threadCompactions.filter(
    (existing) =>
      !(
        existing.thread_key === row.thread_key &&
        existing.ordinal === row.ordinal
      )
  );
  state.threadCompactions.push(row);
}

function deleteThreadMessages(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.threadMessages = state.threadMessages.filter(
    (row) => row.thread_key !== key
  );
}

function deleteThreadMessageChunks(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.threadMessageChunks = state.threadMessageChunks.filter(
    (row) => row.thread_key !== key
  );
}

function deactivateThreadMessages(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  const minSeq = query.includes("seq >= ?")
    ? numberBinding(bindings[1])
    : Number.NEGATIVE_INFINITY;
  for (const row of state.threadMessages) {
    if (row.thread_key === key && row.active === 1 && row.seq >= minSeq) {
      row.active = 0;
    }
  }
}

function insertThreadMessage(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const hasImplicitSeq = query.includes("values (?, 0, 1, ?)");
  state.threadMessages.push({
    active: 1,
    message: stringBinding(hasImplicitSeq ? bindings[1] : bindings[2]),
    seq: hasImplicitSeq ? 0 : numberBinding(bindings[1]),
    thread_key: stringBinding(bindings[0]),
  });
}

function insertThreadMessageChunk(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const row: ThreadMessageChunkRow = {
    chunk: stringBinding(bindings[3]),
    chunk_index: numberBinding(bindings[2]),
    seq: numberBinding(bindings[1]),
    thread_key: stringBinding(bindings[0]),
  };
  state.threadMessageChunks = state.threadMessageChunks.filter(
    (existing) =>
      !(
        existing.thread_key === row.thread_key &&
        existing.seq === row.seq &&
        existing.chunk_index === row.chunk_index
      )
  );
  state.threadMessageChunks.push(row);
}

function insertThreadMeta(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.threadMeta.set(key, createThreadMetaRow(key, bindings));
}

function createThreadMetaRow(
  key: string,
  bindings: readonly unknown[]
): ThreadMetaRow {
  if (bindings.length >= 5) {
    return {
      applied_migrations: nullableStringBinding(bindings[5]),
      message_count: numberBinding(bindings[2]),
      next_seq: numberBinding(bindings[3]),
      state_blob: nullableStringBinding(bindings[4]),
      thread_key: key,
      version: stringBinding(bindings[1]),
    };
  }
  return {
    applied_migrations: null,
    message_count: 1,
    next_seq: 1,
    state_blob: null,
    thread_key: key,
    version: 1,
  };
}
