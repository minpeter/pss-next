import { appendFile } from "node:fs/promises";

export type AgenticTraceEvent =
  | {
      readonly requestAttempt: number;
      readonly run: number;
      readonly task: string;
      readonly timestampMs: number;
      readonly type: "attempt_started";
    }
  | {
      readonly requestAttempt: number;
      readonly run: number;
      readonly system: string;
      readonly task: string;
      readonly timestampMs: number;
      readonly type: "prompt_sent";
      readonly user: string;
    }
  | {
      readonly inputJson: string;
      readonly name: "edit_file" | "read_file";
      readonly requestAttempt: number;
      readonly run: number;
      readonly task: string;
      readonly timestampMs: number;
      readonly type: "tool_call";
    }
  | {
      readonly error?: string;
      readonly name: "edit_file" | "read_file";
      readonly output?: string;
      readonly requestAttempt: number;
      readonly run: number;
      readonly task: string;
      readonly timestampMs: number;
      readonly type: "tool_result";
    }
  | {
      readonly requestAttempt: number;
      readonly responseMessagesJson: string;
      readonly run: number;
      readonly task: string;
      readonly text: string;
      readonly timestampMs: number;
      readonly type: "model_response";
    }
  | {
      readonly diagnostics: readonly string[];
      readonly passed: boolean;
      readonly requestAttempt: number;
      readonly run: number;
      readonly task: string;
      readonly timestampMs: number;
      readonly type: "verification";
    }
  | {
      readonly error: string;
      readonly requestAttempt: number;
      readonly run: number;
      readonly task: string;
      readonly timestampMs: number;
      readonly type: "request_error";
    }
  | {
      readonly requestAttempt: number;
      readonly run: number;
      readonly task: string;
      readonly timestampMs: number;
      readonly type: "attempt_finished";
    };

export type AgenticTraceSink = (
  event: AgenticTraceEvent
) => Promise<void> | void;

export const createAgenticTraceWriter = (path: string): AgenticTraceSink => {
  let pending = Promise.resolve();
  return (event) => {
    pending = pending.then(() =>
      appendFile(path, `${JSON.stringify(event)}\n`, "utf8")
    );
    return pending;
  };
};
