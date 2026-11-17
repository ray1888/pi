import { INVESTIGATION_TOOL_NAMES } from "./tools.js";
import type { Observed } from "./policy-snapshot.js";

/**
 * 编排策略是 A/B 的唯一变量。
 * 共同基线上这里不设顺序栅栏。
 * fixed 分支会拒绝“还没走到那一步”的合法只读调用。
 * adaptive 分支允许白名单内的任意顺序，但不放宽白名单、重试上限或轮次预算。
 */
export type OrderFence = "none" | "adaptive" | "fixed";

export const ORDER_FENCE: OrderFence = "fixed";

export type PolicyCode = "allow" | "phase_order" | "not_whitelisted";

export interface PolicyDecision {
  readonly allow: boolean;
  readonly code: PolicyCode;
  readonly reason: string;
  readonly nextTool?: string;
}

const WHITELIST = new Set<string>(INVESTIGATION_TOOL_NAMES);

export function evaluatePolicy(toolName: string, serviceId: string | undefined, observed: Observed): PolicyDecision {
  if (!WHITELIST.has(toolName)) {
    return {
      allow: false,
      code: "not_whitelisted",
      reason: `code=not_whitelisted tool=${toolName} 只读白名单拒绝。没有执行 shell 或写操作。`,
    };
  }
  const fenced = orderFence(toolName, serviceId, observed);
  if (fenced) return fenced;
  return { allow: true, code: "allow", reason: "allow" };
}

/**
 * 分支替换这个函数。返回 undefined 表示顺序上允许。
 * 基线不额外限制顺序，这样原有 14 项回归不经过这道栅栏。
 */
export function orderFence(
  toolName: string,
  serviceId: string | undefined,
  observed: Observed,
): PolicyDecision | undefined {
  const nextTool = missingPrerequisite(toolName, serviceId, observed);
  if (!nextTool) return undefined;
  return {
    allow: false,
    code: "phase_order",
    nextTool,
    reason: phaseReason(nextTool, serviceId, fenceWhy(nextTool)),
  };
}

function missingPrerequisite(toolName: string, serviceId: string | undefined, observed: Observed): string | undefined {
  if (toolName === "list_services") return undefined;
  if (!observed.listed) return "list_services";
  if (toolName === "get_service_health") return undefined;
  if (!serviceId || !observed.health.has(serviceId)) return "get_service_health";
  if (toolName === "get_dependency_health") return undefined;
  if (!observed.dependencies.has(serviceId)) return "get_dependency_health";
  return undefined;
}

function fenceWhy(nextTool: string): string {
  if (nextTool === "list_services") {
    return "先列出模拟目录，再按 id 读健康。这是顺序约束，不是说该 id 非法。";
  }
  if (nextTool === "get_service_health") {
    return "先读该服务自身健康，再看依赖或错误。这是顺序约束。";
  }
  return "固定清单要求先看依赖，再读错误样本。错误样本本身是合法只读动作。";
}

export function phaseReason(nextTool: string, serviceId: string | undefined, why: string): string {
  const id = serviceId ? ` serviceId=${serviceId}` : "";
  return `code=phase_order nextTool=${nextTool}${id} ${why}`;
}

export function serviceIdOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("serviceId" in args)) return undefined;
  return typeof args.serviceId === "string" ? args.serviceId : undefined;
}
