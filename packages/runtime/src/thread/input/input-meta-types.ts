export type InputSource =
  | "delegate"
  | "follow-up"
  | "notify"
  | "overlay"
  | "send"
  | "steer";

export interface InputEventMeta {
  readonly delegateToolName?: string;
  readonly source: InputSource;
  readonly streaming?: "follow-up" | "steer";
}
