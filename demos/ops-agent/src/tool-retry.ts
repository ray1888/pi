import { BOUNDS } from "./pin.js";
import { isRetryableKind, ToolFailure, toToolFailure, wait } from "./failures.js";
import type { AttemptRecord } from "./trace.js";

export interface ReadOnlyRetryPolicy {
  readonly effect: "read-only";
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly baseBackoffMs: number;
}

export type ReadOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: readonly AttemptRecord[] }
  | { readonly ok: false; readonly failure: ToolFailure; readonly attempts: readonly AttemptRecord[] };

/**
 * 只包在只读工具的 execute 里面。
 * pi 的 executePreparedToolCall 对一次 tool call 只调用一次 execute；
 * 这里的多次 attempt 是 demo 自己的工具层重试，模型只看见最终结果。
 * 写操作 / 非幂等调用不要接这个函数：失败后重放可能重复生效。本 demo 不实现写工具。
 */
export async function withReadOnlyRetry<T>(
  policy: ReadOnlyRetryPolicy,
  signal: AbortSignal | undefined,
  tool: string,
  read: (signal: AbortSignal) => Promise<T>,
  onAttempt: (record: AttemptRecord) => void,
): Promise<ReadOutcome<T>> {
  assertPolicy(policy);
  const attempts: AttemptRecord[] = [];

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      const failure = toToolFailure(undefined, signal);
      const record = recordOf(tool, attempt, policy.maxAttempts, failure, undefined);
      attempts.push(record);
      onAttempt(record);
      return { ok: false, failure, attempts };
    }

    const timeout = AbortSignal.timeout(policy.timeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const value = await read(attemptSignal);
      const record = {
        tool,
        attempt,
        maxAttempts: policy.maxAttempts,
        outcome: "ok" as const,
        code: "ok",
      };
      attempts.push(record);
      onAttempt(record);
      return { ok: true, value, attempts };
    } catch (error) {
      const failure = toToolFailure(error, signal);
      const canRetry = isRetryableKind(failure.kind) && attempt < policy.maxAttempts;
      const nextDelayMs = canRetry ? backoffMs(policy.baseBackoffMs, attempt) : undefined;
      const record = recordOf(tool, attempt, policy.maxAttempts, failure, nextDelayMs);
      attempts.push(record);
      onAttempt(record);
      if (!canRetry) {
        const reported =
          isRetryableKind(failure.kind) && attempt >= policy.maxAttempts
            ? new ToolFailure(
                failure.kind,
                failure.code,
                `retry_exhausted code=${failure.code} attempts=${attempt}`,
              )
            : failure;
        return { ok: false, failure: reported, attempts };
      }
      try {
        await wait(nextDelayMs ?? 0, signal);
      } catch (waitError) {
        const cancelled = toToolFailure(waitError, signal);
        return { ok: false, failure: cancelled, attempts };
      }
    }
  }

  return {
    ok: false,
    failure: new ToolFailure("terminal", "retry_bug", "terminal code=retry_bug"),
    attempts,
  };
}

function recordOf(
  tool: string,
  attempt: number,
  maxAttempts: number,
  failure: ToolFailure,
  nextDelayMs: number | undefined,
): AttemptRecord {
  return {
    tool,
    attempt,
    maxAttempts,
    outcome: failure.kind,
    code: failure.code,
    ...(nextDelayMs === undefined ? {} : { nextDelayMs }),
  };
}

function backoffMs(base: number, attempt: number): number {
  const raw = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, BOUNDS.maxBackoffMs);
}

function assertPolicy(policy: ReadOnlyRetryPolicy): void {
  if (policy.effect !== "read-only") {
    throw new ToolFailure("terminal", "refusing_retry", "terminal code=refusing_retry");
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > BOUNDS.maxToolAttempts) {
    throw new ToolFailure("terminal", "bad_policy", `terminal code=bad_policy maxAttempts`);
  }
  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1 || policy.timeoutMs > BOUNDS.maxTimeoutMs) {
    throw new ToolFailure("terminal", "bad_policy", "terminal code=bad_policy timeoutMs");
  }
  if (!Number.isInteger(policy.baseBackoffMs) || policy.baseBackoffMs < 0 || policy.baseBackoffMs > BOUNDS.maxBackoffMs) {
    throw new ToolFailure("terminal", "bad_policy", "terminal code=bad_policy backoff");
  }
}
