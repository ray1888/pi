export type FailureKind = "retryable" | "terminal" | "timeout" | "cancelled";

export class ToolFailure extends Error {
  readonly kind: FailureKind;
  readonly code: string;

  constructor(kind: FailureKind, code: string, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.kind = kind;
    this.code = code;
  }
}

export function isRetryableKind(kind: FailureKind): boolean {
  return kind === "retryable" || kind === "timeout";
}

export function failureFromAbort(signal: AbortSignal): ToolFailure {
  if (isTimeoutReason(signal.reason)) {
    return new ToolFailure("timeout", "attempt_timeout", "attempt_timeout 单次模拟读取超时");
  }
  return new ToolFailure("cancelled", "cancelled", "cancelled 已取消");
}

export function toToolFailure(error: unknown, parent: AbortSignal | undefined): ToolFailure {
  if (parent?.aborted) {
    return failureFromAbort(parent);
  }
  if (error instanceof ToolFailure) return error;
  if (error instanceof Error) {
    return new ToolFailure("terminal", "unexpected", `terminal code=unexpected ${error.name}`);
  }
  return new ToolFailure("terminal", "unexpected", "terminal code=unexpected");
}

function isTimeoutReason(reason: unknown): boolean {
  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return reason.name === "TimeoutError";
  }
  return reason instanceof Error && reason.name === "TimeoutError";
}

export function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(failureFromAbort(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) reject(failureFromAbort(signal));
      else reject(new ToolFailure("cancelled", "cancelled", "cancelled 已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
