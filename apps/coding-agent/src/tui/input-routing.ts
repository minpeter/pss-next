import type { AgentTurn } from "@minpeter/pss-runtime";

export type InputPreprocessResult =
  | {
      message: string;
      success: true;
      translatedDisplay?: string;
    }
  | {
      error: string;
      success: false;
    };

export interface InputPreprocessHooks {
  clearStatus: () => void;
  showStatus: (text: string) => void;
}

export interface InputThread {
  send(input: string): Promise<AgentTurn>;
  steer(input: string): Promise<AgentTurn>;
}

interface PreparedInput {
  message: string;
  translatedDisplay?: string;
}

export type UserInputDispatch =
  | {
      error: string;
      type: "rejected";
    }
  | {
      consumeRun: boolean;
      run: AgentTurn;
      translatedDisplay?: string;
      type: "sent" | "steered";
    };

export const dispatchUserInput = async (options: {
  activeRun?: AgentTurn;
  hooks: InputPreprocessHooks;
  input: string;
  onPrepared?: (input: PreparedInput) => void;
  preprocess?: (
    input: string,
    hooks: InputPreprocessHooks
  ) => Promise<InputPreprocessResult | undefined>;
  thread: InputThread;
}): Promise<UserInputDispatch> => {
  const preprocessed = await options.preprocess?.(options.input, options.hooks);
  if (preprocessed?.success === false) {
    return { error: preprocessed.error, type: "rejected" };
  }

  const prepared: PreparedInput = {
    message: preprocessed?.message ?? options.input,
    translatedDisplay: preprocessed?.translatedDisplay,
  };
  options.onPrepared?.(prepared);

  if (options.activeRun === undefined) {
    return {
      consumeRun: true,
      run: await options.thread.send(prepared.message),
      translatedDisplay: prepared.translatedDisplay,
      type: "sent",
    };
  }

  const run = await options.thread.steer(prepared.message);
  return {
    consumeRun: run !== options.activeRun,
    run,
    translatedDisplay: prepared.translatedDisplay,
    type: "steered",
  };
};
