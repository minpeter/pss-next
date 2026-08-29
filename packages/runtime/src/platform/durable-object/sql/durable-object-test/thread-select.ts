import { numberBinding, stringBinding } from "./bindings";
import type {
  InMemoryDurableObjectSqlState,
  ThreadCompactionRow,
  ThreadInputRow,
  ThreadMessageChunkRow,
  ThreadMessageRow,
  ThreadMetaRow,
} from "./state";

export function selectThreadSqlRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  if (query.includes("from pss_thread_input")) {
    return selectThreadInputRows(state, query, bindings);
  }
  if (query.includes("from pss_thread_meta")) {
    return selectThreadMetaRows(state, query, bindings);
  }
  if (query.includes("from pss_thread_compaction")) {
    return selectThreadCompactionRows(state, query, bindings);
  }
  if (query.includes("from pss_thread_message_chunk")) {
    return selectThreadMessageChunkRows(state, bindings);
  }
  if (query.includes("from pss_thread_message")) {
    return selectThreadMessageRows(state, query, bindings);
  }
  throw new Error(`Unsupported in-memory thread SQL query: ${query}`);
}

function selectThreadInputRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  const threadKey = stringBinding(bindings[1]);
  const rows = state.threadInputs.filter((row) => {
    if (row.prefix !== prefix || row.thread_key !== threadKey) {
      return false;
    }
    if (query.includes("message_id = ?")) {
      return row.message_id === stringBinding(bindings[2]);
    }
    if (query.includes("status = ?")) {
      return row.status === stringBinding(bindings[2]);
    }
    return true;
  });
  if (query.startsWith("select count(*) as count")) {
    return [{ count: rows.length }];
  }
  return [...rows]
    .sort(
      (left: ThreadInputRow, right: ThreadInputRow) =>
        left.admitted_seq - right.admitted_seq ||
        left.message_id.localeCompare(right.message_id)
    )
    .map((row) => projectThreadInput(row, query));
}

function selectThreadMetaRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  if (query.includes("where thread_key = ?")) {
    const key = stringBinding(bindings[0]);
    const row = state.threadMeta.get(key);
    return row ? [projectThreadMeta(row, query)] : [];
  }
  if (query === "select thread_key from pss_thread_meta") {
    return [...state.threadMeta.keys()].map((thread_key) => ({ thread_key }));
  }
  throw new Error(`Unsupported in-memory thread meta SQL query: ${query}`);
}

function selectThreadCompactionRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  return state.threadCompactions
    .filter((row) => row.thread_key === key)
    .sort(
      (left: ThreadCompactionRow, right: ThreadCompactionRow) =>
        left.ordinal - right.ordinal
    )
    .map((row) => projectThreadCompaction(row, query));
}

function selectThreadMessageRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  return state.threadMessages
    .filter((row) => {
      if (row.thread_key !== key) {
        return false;
      }
      return query.includes("active = 1") ? row.active === 1 : true;
    })
    .sort(
      (left: ThreadMessageRow, right: ThreadMessageRow) => left.seq - right.seq
    )
    .map((row) => projectThreadMessage(row, query));
}

function selectThreadMessageChunkRows(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const seqs = new Set(bindings.slice(1).map(numberBinding));
  return state.threadMessageChunks
    .filter((row) => row.thread_key === key && seqs.has(row.seq))
    .sort(
      (left: ThreadMessageChunkRow, right: ThreadMessageChunkRow) =>
        left.seq - right.seq || left.chunk_index - right.chunk_index
    )
    .map((row) => ({
      chunk: row.chunk,
      chunk_index: row.chunk_index,
      seq: row.seq,
    }));
}

function projectThreadInput(row: ThreadInputRow, query: string): unknown {
  const projected: Record<string, unknown> = {};
  if (query.includes("admitted_seq")) {
    projected.admitted_seq = row.admitted_seq;
  }
  if (query.includes("message_id")) {
    projected.message_id = row.message_id;
  }
  if (query.includes("record")) {
    projected.record = row.record;
  }
  if (query.includes("status")) {
    projected.status = row.status;
  }
  return projected;
}

function projectThreadMeta(row: ThreadMetaRow, query: string): unknown {
  if (query.startsWith("select version, message_count, next_seq, state_blob")) {
    return {
      applied_migrations: row.applied_migrations,
      message_count: row.message_count,
      next_seq: row.next_seq,
      state_blob: row.state_blob,
      version: row.version,
    };
  }
  return structuredClone(row);
}

function projectThreadMessage(row: ThreadMessageRow, query: string): unknown {
  const projected: Record<string, unknown> = {};
  if (query.includes("seq")) {
    projected.seq = row.seq;
  }
  if (query.includes("active")) {
    projected.active = row.active;
  }
  if (query.includes("message")) {
    projected.message = row.message;
  }
  return projected;
}

function projectThreadCompaction(
  row: ThreadCompactionRow,
  query: string
): unknown {
  if (query.includes("ordinal")) {
    return {
      end_seq_exclusive: row.end_seq_exclusive,
      ordinal: row.ordinal,
      start_seq: row.start_seq,
      summary: row.summary,
    };
  }
  return {
    end_seq_exclusive: row.end_seq_exclusive,
    start_seq: row.start_seq,
    summary: row.summary,
  };
}
