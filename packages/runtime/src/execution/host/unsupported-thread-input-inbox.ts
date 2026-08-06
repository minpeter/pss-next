export class ThreadInputInboxUnavailableError extends Error {
  readonly name = "ThreadInputInboxUnavailableError";

  constructor() {
    super("ThreadInputInbox is not implemented for this execution store.");
  }
}
