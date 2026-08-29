import { isDefined } from "../../../../execution/scheduled-work";
import {
  type DurableObjectScheduledThreadPrompt as CloudflareScheduledThreadPrompt,
  isCanonicalRunWork,
  isCanonicalThreadPromptWork,
  parseScheduledRunPayload,
  parseScheduledThreadPromptPayload,
} from "../../host/scheduled-work-codec";
import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import {
  deleteScheduledWork,
  type ScheduledWorkKind,
  type ScheduledWorkRow,
  selectScheduledWork,
} from "../../storage/sqlite/scheduled-work-table";
import {
  agentsRunKind,
  agentsThreadPromptKind,
  alarmRunKind,
  alarmThreadPromptKind,
} from "./scheduled-work-kinds";

const defaultPrefix = "pss-runtime";

export function listCloudflareAgentsScheduledRuns(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly string[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    selectScheduledWorkByKinds(storage, prefix, runKindSelections, {
      limit: options.limit,
    })
      .map((row) => parseScheduledRunPayload(row.payload))
      .filter(isDefined)
  );
}

export function listCloudflareAgentsScheduledThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    selectScheduledWorkByKinds(storage, prefix, threadPromptKindSelections, {
      limit: options.limit,
    })
      .map((row) => parseScheduledThreadPromptPayload(row.payload))
      .filter(isDefined)
  );
}

export async function ackListedCloudflareAgentsScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await deleteMatchingScheduledWorkKinds({
    kinds: [agentsRunKind, alarmRunKind],
    matches: (payload) => parseScheduledRunPayload(payload) === runId,
    prefix: options.prefix ?? defaultPrefix,
    storage,
  });
}

export async function ackListedCloudflareAgentsScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await deleteMatchingScheduledWorkKinds({
    kinds: [agentsThreadPromptKind, alarmThreadPromptKind],
    matches: (payload) => {
      const value = parseScheduledThreadPromptPayload(payload);
      return (
        value !== undefined &&
        value.threadKey === prompt.threadKey &&
        value.idempotencyKey === prompt.idempotencyKey &&
        value.notificationId === prompt.notificationId &&
        value.runId === prompt.runId
      );
    },
    prefix: options.prefix ?? defaultPrefix,
    storage,
  });
}

async function deleteMatchingScheduledWorkKinds({
  kinds,
  matches,
  prefix,
  storage,
}: {
  readonly kinds: readonly ScheduledWorkKind[];
  readonly matches: (payload: string) => boolean;
  readonly prefix: string;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  await Promise.all(
    kinds.flatMap((kind) =>
      selectScheduledWork(storage, prefix, kind)
        .filter((row) => matches(row.payload))
        .map((row) => deleteScheduledWork(storage, prefix, kind, row.work_id))
    )
  );
}

interface ScheduledWorkKindSelection {
  readonly kind: ScheduledWorkKind;
  readonly rowFilter?: (row: ScheduledWorkRow) => boolean;
}

// Alarm-kind rows must round-trip the alarm scheduler's canonical work id;
// rows in any other format cannot be claimed and must stay invisible here.
const runKindSelections: readonly ScheduledWorkKindSelection[] = [
  { kind: agentsRunKind },
  { kind: alarmRunKind, rowFilter: isCanonicalRunWork },
];

const threadPromptKindSelections: readonly ScheduledWorkKindSelection[] = [
  { kind: agentsThreadPromptKind },
  { kind: alarmThreadPromptKind, rowFilter: isCanonicalThreadPromptWork },
];

function selectScheduledWorkByKinds(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  selections: readonly ScheduledWorkKindSelection[],
  options: { readonly limit?: number }
): ScheduledWorkRow[] {
  const rows: ScheduledWorkRow[] = [];
  for (const { kind, rowFilter } of selections) {
    const remaining = remainingListLimit(options.limit, rows.length);
    if (remaining === 0) {
      break;
    }
    const selected =
      rowFilter === undefined
        ? selectScheduledWork(storage, prefix, kind, remaining)
        : selectScheduledWork(storage, prefix, kind);
    const matching =
      rowFilter === undefined ? selected : selected.filter(rowFilter);
    rows.push(
      ...(remaining === undefined ? matching : matching.slice(0, remaining))
    );
  }
  return rows;
}

function remainingListLimit(
  limit: number | undefined,
  count: number
): number | undefined {
  if (limit === undefined) {
    return;
  }
  return Math.max(0, Math.floor(limit) - count);
}
