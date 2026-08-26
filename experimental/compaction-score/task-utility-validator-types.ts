export interface TaskValidation {
  readonly checks: readonly {
    readonly id: string;
    readonly passed: boolean;
  }[];
  readonly passed: boolean;
}
