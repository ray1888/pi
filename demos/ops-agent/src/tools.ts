import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import type { DependencyReport, ErrorReport, SimulatedDirectory, SimulatedHealth, ServiceListing } from "./catalog.js";
import { ToolFailure } from "./failures.js";
import type { AttemptRecord } from "./trace.js";
import { withReadOnlyRetry, type ReadOnlyRetryPolicy } from "./tool-retry.js";

const listParameters = obj({});

const healthParameters = obj({
  serviceId: str({ description: "模拟目录里的服务 id，例如 checkout-api。不是集群名。" }),
});

export interface ToolHooks {
  readonly directory: SimulatedDirectory;
  readonly retry: ReadOnlyRetryPolicy;
  readonly onAttempt: (record: AttemptRecord) => void;
}

export function createReadOnlyTools(hooks: ToolHooks): AgentTool[] {
  const listServices: AgentTool<typeof listParameters> = {
    name: "list_services",
    label: "列出模拟服务",
    description: "列出本地模拟目录中的服务 id 和稳态状态。不访问集群，不执行 shell。",
    parameters: listParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, _params, signal) => {
      const outcome = await withReadOnlyRetry(
        hooks.retry,
        signal,
        "list_services",
        async () => hooks.directory.listServices(),
        hooks.onAttempt,
      );
      return toResult(outcome);
    },
  };

  const getServiceHealth: AgentTool<typeof healthParameters> = {
    name: "get_service_health",
    label: "读取模拟健康",
    description: "按 serviceId 读取一条本地模拟健康记录。只读。未知 id 会返回 terminal 错误，不会重试。",
    parameters: healthParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const outcome = await withReadOnlyRetry(
        hooks.retry,
        signal,
        "get_service_health",
        (attemptSignal) => hooks.directory.readHealth(params.serviceId, attemptSignal),
        hooks.onAttempt,
      );
      return toResult(outcome);
    },
  };

  return [listServices, getServiceHealth];
}

export function createInvestigationTools(hooks: ToolHooks): AgentTool[] {
  const [listServices, getServiceHealth] = createReadOnlyTools(hooks);
  if (!listServices || !getServiceHealth) {
    throw new Error("只读工具定义缺失");
  }

  const dependencyParameters = healthParameters;
  const errorParameters = healthParameters;

  const getDependencyHealth: AgentTool<typeof dependencyParameters> = {
    name: "get_dependency_health",
    label: "读取模拟依赖",
    description: "只读。返回该服务在模拟目录里的直接依赖状态。未知 id 不重试。",
    parameters: dependencyParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const outcome = await withReadOnlyRetry(
        hooks.retry,
        signal,
        "get_dependency_health",
        (attemptSignal) => hooks.directory.readDependencies(params.serviceId, attemptSignal),
        hooks.onAttempt,
      );
      return jsonResult(outcome);
    },
  };

  const getRecentErrors: AgentTool<typeof errorParameters> = {
    name: "get_recent_errors",
    label: "读取模拟错误样本",
    description: "只读。返回模拟错误行。没有 shell，不能按样本去改服务。",
    parameters: errorParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const outcome = await withReadOnlyRetry(
        hooks.retry,
        signal,
        "get_recent_errors",
        (attemptSignal) => hooks.directory.readErrors(params.serviceId, attemptSignal),
        hooks.onAttempt,
      );
      return jsonResult(outcome);
    },
  };

  return [listServices, getServiceHealth, getDependencyHealth, getRecentErrors];
}

export const READ_ONLY_TOOL_NAMES = ["list_services", "get_service_health"] as const;
export const INVESTIGATION_TOOL_NAMES = [
  "list_services",
  "get_service_health",
  "get_dependency_health",
  "get_recent_errors",
] as const;

function jsonResult(
  outcome:
    | { readonly ok: true; readonly value: DependencyReport | ErrorReport; readonly attempts: readonly AttemptRecord[] }
    | { readonly ok: false; readonly failure: ToolFailure; readonly attempts: readonly AttemptRecord[] },
): AgentToolResult<{ readonly source: "simulated-local"; readonly attempts: readonly AttemptRecord[]; readonly failureCode?: string }> {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: outcome.failure.message }],
      details: { source: "simulated-local", attempts: outcome.attempts, failureCode: outcome.failure.code },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(outcome.value) }],
    details: { source: "simulated-local", attempts: outcome.attempts },
  };
}

interface ToolDetails {
  readonly source: "simulated-local";
  readonly attempts: readonly AttemptRecord[];
  readonly health?: SimulatedHealth;
  readonly listing?: ServiceListing;
  readonly failureCode?: string;
}

function toResult(
  outcome:
    | { readonly ok: true; readonly value: SimulatedHealth | ServiceListing; readonly attempts: readonly AttemptRecord[] }
    | { readonly ok: false; readonly failure: ToolFailure; readonly attempts: readonly AttemptRecord[] },
): AgentToolResult<ToolDetails> {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: outcome.failure.message }],
      details: {
        source: "simulated-local",
        attempts: outcome.attempts,
        failureCode: outcome.failure.code,
      },
      isError: true,
    };
  }
  const health = isHealth(outcome.value) ? outcome.value : undefined;
  const listing = isHealth(outcome.value) ? undefined : outcome.value;
  return {
    content: [{ type: "text", text: JSON.stringify(outcome.value) }],
    details: {
      source: "simulated-local",
      attempts: outcome.attempts,
      ...(health === undefined ? {} : { health }),
      ...(listing === undefined ? {} : { listing }),
    },
  };
}

function isHealth(value: SimulatedHealth | ServiceListing): value is SimulatedHealth {
  return "serviceId" in value && !("services" in value);
}
