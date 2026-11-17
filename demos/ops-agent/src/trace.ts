export interface AttemptRecord {
  readonly tool: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outcome: "ok" | "retryable" | "terminal" | "timeout" | "cancelled";
  readonly code: string;
  readonly nextDelayMs?: number;
}

export type TraceEvent =
  | {
      readonly type: "run_start";
      readonly scenario: string;
      readonly modelAdapter: "scripted-faux-not-a-real-llm";
      readonly piAgentCore: "1.5.2";
      readonly data: "simulated-local";
    }
  | {
      readonly type: "message_end";
      readonly role: string;
      readonly stopReason?: string;
      readonly isError?: boolean;
      readonly toolName?: string;
      readonly text: string;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolName: string;
      readonly args: unknown;
    }
  | ({ readonly type: "tool_attempt" } & AttemptRecord)
  | {
      readonly type: "tool_execution_end";
      readonly toolName: string;
      readonly isError: boolean;
      readonly text: string;
    }
  | {
      readonly type: "transport_retry";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorMessage: string;
    }
  | { readonly type: "turn"; readonly index: number; readonly stopReason: string }
  | { readonly type: "stop"; readonly reason: string };

export class TraceLog {
  readonly events: TraceEvent[] = [];

  push(event: TraceEvent): void {
    this.events.push(event);
  }

  toJsonl(): string {
    return this.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  }
}
