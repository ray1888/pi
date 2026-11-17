import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { lastToolFeedback } from "./inspect.js";
import { providerError, repeat, say, toolCall, type ScriptStep } from "./scripted-model.js";
import type { ReadOnlyRetryPolicy } from "./tool-retry.js";

export interface TransportChoice {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly user: string;
  readonly responses: readonly FauxResponseStep[];
  readonly maxTurns: number;
  readonly retry: ReadOnlyRetryPolicy;
  readonly transport: TransportChoice;
  readonly abortAfterToolStartMs?: number;
}

const readOnly = {
  effect: "read-only" as const,
  maxAttempts: 3,
  timeoutMs: 200,
  baseBackoffMs: 1,
};

const noTransport: TransportChoice = { enabled: false, maxRetries: 0, baseDelayMs: 1 };

function times(step: ScriptStep, count: number): FauxResponseStep[] {
  return repeat(step, count);
}

function continueAfterTool(context: TranscriptContext, first: AssistantMessage): AssistantMessage {
  const feedback = lastToolFeedback(context);
  if (!feedback) return first;
  if (feedback.isError && feedback.text.includes("unknown_service")) {
    return toolCall("get_service_health", { serviceId: "checkout-api" }, "call-fixed-service");
  }
  if (feedback.isError && feedback.text.includes("Validation failed")) {
    return toolCall("get_service_health", { serviceId: "checkout-api" }, "call-fixed-schema");
  }
  if (feedback.isError && feedback.text.includes("not found")) {
    return say("bash 不在白名单里，停止。没有执行 shell。");
  }
  if (!feedback.isError && feedback.text.includes("simulated-local")) {
    return say("已读到模拟健康数据，source=simulated-local。停止。");
  }
  return say(`停止。${feedback.text}`);
}

function script(first: AssistantMessage): ScriptStep {
  return (context) => continueAfterTool(context, first);
}

function stopAfterTool(context: TranscriptContext, first: AssistantMessage): AssistantMessage {
  const feedback = lastToolFeedback(context);
  if (!feedback) return first;
  return say(`停止。不重试。${feedback.text}`);
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "success",
    title: "一次读到模拟健康数据后停止",
    user: "看一下 checkout-api 的健康状态。只准看模拟目录。",
    responses: times(script(toolCall("get_service_health", { serviceId: "checkout-api" }, "call-checkout")), 4),
    maxTurns: 4,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "transient-tool",
    title: "工具层把两次模拟 503 重试掉，模型只调用一次",
    user: "看一下 inventory。如果是暂时的上游错误，由工具重试，不要换服务。",
    responses: times(script(toolCall("get_service_health", { serviceId: "inventory" }, "call-inventory")), 4),
    maxTurns: 4,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "terminal-no-retry",
    title: "未知服务是不可重试错误，工具只执行一次",
    user: "查询 no-such-service。如果目录里没有，就停止，不要重试。",
    responses: times(
      (context) => stopAfterTool(context, toolCall("get_service_health", { serviceId: "no-such-service" }, "call-missing")),
      4,
    ),
    maxTurns: 4,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "retry-exhausted",
    title: "可重试错误达到次数上限后停止",
    user: "查询 ledger。暂时失败可以重试，但必须有上限。",
    responses: times(script(toolCall("get_service_health", { serviceId: "ledger" }, "call-ledger")), 4),
    maxTurns: 4,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "timeout-then-ok",
    title: "单次超时后再读一次成功",
    user: "查询 slow-then-fast。单次读太慢就放弃这一次，还可以再试。",
    responses: times(script(toolCall("get_service_health", { serviceId: "slow-then-fast" }, "call-slow-fast")), 4),
    maxTurns: 4,
    retry: { ...readOnly, timeoutMs: 30 },
    transport: noTransport,
  },
  {
    id: "cancel",
    title: "取消后不再发下一次工具重试",
    user: "查询 slow-probe，这个读取会被取消。",
    responses: times(script(toolCall("get_service_health", { serviceId: "slow-probe" }, "call-slow")), 4),
    maxTurns: 4,
    retry: { ...readOnly, timeoutMs: 2_000 },
    transport: noTransport,
    abortAfterToolStartMs: 40,
  },
  {
    id: "model-fixes-args",
    title: "模型看见未知服务后改用目录里的 id",
    user: "先按你猜的名字查，如果没有，改查 checkout-api。",
    responses: times(script(toolCall("get_service_health", { serviceId: "no-such-service" }, "call-guess")), 4),
    maxTurns: 4,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "schema-then-fix",
    title: "参数没通过 schema 时不执行工具，下一轮补上 serviceId",
    user: "查健康，但你第一次可能会漏掉 serviceId。",
    responses: times(script(toolCall("get_service_health", {}, "call-empty")), 4),
    maxTurns: 4,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "unknown-tool",
    title: "未注册的 bash 不会执行",
    user: "不要用 shell。",
    responses: times(script(toolCall("bash", { command: "kubectl get pods" }, "call-bash")), 4),
    maxTurns: 4,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "turn-cap",
    title: "模型一直要工具时，轮次上限会停住",
    user: "不停地列出服务。演示应该在轮次上限处停下。",
    responses: times((context) => toolCall("list_services", {}, `call-list-${context.messages.length}`), 8),
    maxTurns: 3,
    retry: readOnly,
    transport: noTransport,
  },
  {
    id: "transport-recovers",
    title: "脚本里的 503 由 pi-ai retryAssistantCall 吃掉，Agent 只看到恢复后的工具调用",
    user: "传输抖了一下之后，再看 checkout-api。",
    responses: [
      providerError("503 service unavailable"),
      toolCall("get_service_health", { serviceId: "checkout-api" }, "call-after-503"),
      say("传输恢复后读到模拟数据。停止。"),
    ],
    maxTurns: 4,
    retry: readOnly,
    transport: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
  },
  {
    id: "transport-not-retryable",
    title: "不像暂时故障的 provider 错误不重试",
    user: "这次不该重试传输。",
    responses: [providerError("invalid api key"), toolCall("get_service_health", { serviceId: "checkout-api" }, "call-should-not-run")],
    maxTurns: 4,
    retry: readOnly,
    transport: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
  },
  {
    id: "transport-exhausted",
    title: "暂时的 503 重试到上限后，整轮以 provider 错误停止",
    user: "传输一直 503。",
    responses: [
      providerError("503 service unavailable"),
      providerError("503 service unavailable"),
      providerError("503 service unavailable"),
      toolCall("get_service_health", { serviceId: "checkout-api" }, "call-should-not-run"),
    ],
    maxTurns: 4,
    retry: readOnly,
    transport: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}
