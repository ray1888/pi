import {
  createAssistantMessageEventStream,
  retryAssistantCall,
  type AssistantMessage,
  type RetryPolicy,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export interface TransportRetryOptions {
  readonly policy: RetryPolicy;
  readonly onRetry: (attempt: number, maxAttempts: number, delayMs: number, errorMessage: string) => void;
}

/**
 * 包住一次 assistant 请求，使用 pi-ai 的 retryAssistantCall。
 * 这一层重试的是模型 API 调用，不是工具。Agent.runLoop 自己不会调用它
 * （见 agent-loop.ts 的 streamAssistantResponse，对 streamFn 只取一次结果）。
 * 真实 provider 客户端里还有 retryProviderRequest；不要在已经开启的 provider 重试外面再套一层。
 * 本 demo 只对会返回脚本错误的 faux stream 打开它。
 */
export function withTransportRetry(inner: StreamFn, options: TransportRetryOptions): StreamFn {
  return async (model, context, streamOptions) => {
    const message = await retryAssistantCall(
      async () => {
        const stream = await inner(model, context, streamOptions);
        return stream.result();
      },
      options.policy,
      streamOptions?.signal,
      {
        onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
          options.onRetry(attempt, maxAttempts, delayMs, errorMessage);
        },
      },
    );
    return replay(message);
  };
}

function replay(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
    return stream;
  }
  stream.push({ type: "done", reason: doneReason(message.stopReason), message });
  return stream;
}

function doneReason(reason: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" | "deferred" {
  switch (reason) {
    case "stop":
    case "length":
    case "toolUse":
    case "deferred":
      return reason;
    case "error":
    case "aborted":
    case "pending":
      return "stop";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}
