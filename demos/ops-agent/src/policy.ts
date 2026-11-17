import { INVESTIGATION_TOOL_NAMES } from "./tools.js";
import type { Observed } from "./policy-snapshot.js";

/**
 * 编排策略是 A/B 的唯一变量。
 * 共同基线上这里不设顺序栅栏。
 * fixed 分支会拒绝“还没走到那一步”的合法只读调用。
 * adaptive 分支允许白名单内的任意顺序，但不放宽白名单、重试上限或轮次预算。
 */
export type OrderFence = "none" | "adaptive" | "fixed";

export const ORDER_FENCE: OrderFence = "adaptive";

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
  _toolName: string,
  _serviceId: string | undefined,
  _observed: Observed,
): PolicyDecision | undefined {
  // 白名单里的只读工具可以按当前证据换顺序、跳过、或改假设后再读。
  // 不在这里放宽 not_whitelisted，也不改变重试次数、超时、取消和轮次预算。
  // 跳过某步只是少了一次观察，不是把外部副作用回滚掉；这些读取没有生产副作用。
  return undefined;
}

export function phaseReason(nextTool: string, serviceId: string | undefined, why: string): string {
  const id = serviceId ? ` serviceId=${serviceId}` : "";
  return `code=phase_order nextTool=${nextTool}${id} ${why}`;
}

export function serviceIdOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("serviceId" in args)) return undefined;
  return typeof args.serviceId === "string" ? args.serviceId : undefined;
}
