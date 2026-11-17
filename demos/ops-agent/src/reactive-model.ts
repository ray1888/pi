import type { AssistantMessage, FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { knownServiceIds } from "./catalog.js";
import { messageText } from "./inspect.js";
import { observeMessages, type Observed } from "./policy-snapshot.js";
import { say, toolCall } from "./scripted-model.js";

/**
 * 两个分支共用的脚本模型。它按已经看见的工具结果决定下一步，不读取 ORDER_FENCE。
 * 这只能约束控制流，不能证明真实模型会这样规划，也不能比较智力或任务成功率。
 */
export function reactiveStep(context: TranscriptContext): AssistantMessage {
  const user = latestUser(context);
  const observed = observeMessages(context.messages);
  const last = lastToolText(context);
  const target = namedService(user) ?? firstHealthId(observed);

  const ordered = phaseOrder(last);
  if (ordered) {
    return callNamed(ordered.nextTool, ordered.serviceId ?? target, context.messages.length);
  }
  if (last && (last.includes("code=not_whitelisted") || last.includes("not found"))) {
    return say("停止。越权动作被拒绝。模拟目录没有写操作，也不存在可回滚的外部副作用。");
  }
  if (user.includes("重启")) {
    return toolCall("restart_service", { serviceId: target ?? "checkout-api" }, id("restart_service", context));
  }
  if (!target) return toolCall("list_services", {}, id("list_services", context));

  const health = observed.health.get(target);
  if (!health) return toolCall("get_service_health", { serviceId: target }, id("get_service_health", context));
  if (health.symptom === "insufficient" || health.status === "unknown") {
    return toolCall("get_service_health", { serviceId: target }, id("get_service_health", context));
  }
  if (health.status === "healthy") {
    return say(`停止。${target} 的模拟健康是 healthy。没有把未读取的检查当成已经完成。`);
  }

  const dependencies = observed.dependencies.get(target);
  const errors = observed.errors.get(target);
  if (health.symptom === "slow_downstream" && !dependencies) {
    return toolCall("get_dependency_health", { serviceId: target }, id("get_dependency_health", context));
  }
  if (health.symptom === "own_5xx" && !errors) {
    return toolCall("get_recent_errors", { serviceId: target }, id("get_recent_errors", context));
  }
  if (dependencies && dependencies.unhealthy.length > 0) {
    return say(`停止。${target} 的模拟依赖里有不可用项：${dependencies.unhealthy.join(",")}。这是重新观察到的结果，不是回滚。`);
  }
  if (errors?.ownException) {
    return say(`停止。${target} 的模拟错误行里有 Exception。依赖如果还没读，就不能声称已经检查过。`);
  }
  if (dependencies && !errors) {
    return toolCall("get_recent_errors", { serviceId: target }, id("get_recent_errors", context));
  }
  if (errors && !dependencies) {
    return toolCall("get_dependency_health", { serviceId: target }, id("get_dependency_health", context));
  }
  return say("停止。已有模拟证据不足以再假设新的原因。");
}

export function reactiveResponses(copies: number): FauxResponseStep[] {
  return Array.from({ length: copies }, () => reactiveStep);
}

function callNamed(tool: string, serviceId: string | undefined, salt: number): AssistantMessage {
  if (tool === "list_services") return toolCall(tool, {}, `call-${tool}-${salt}`);
  return toolCall(tool, { serviceId: serviceId ?? "checkout-api" }, `call-${tool}-${salt}`);
}

function id(tool: string, context: TranscriptContext): string {
  return `call-${tool}-${context.messages.length}`;
}

function latestUser(context: TranscriptContext): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "user") return messageText(message);
  }
  return "";
}

function lastToolText(context: TranscriptContext): string | undefined {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "toolResult") return messageText(message);
  }
  return undefined;
}

function namedService(user: string): string | undefined {
  const ids = [...knownServiceIds()].sort((left, right) => right.length - left.length);
  return ids.find((serviceId) => user.includes(serviceId));
}

function firstHealthId(observed: Observed): string | undefined {
  return observed.health.keys().next().value;
}

function phaseOrder(text: string | undefined): { nextTool: string; serviceId?: string } | undefined {
  if (!text) return undefined;
  const match = /code=phase_order nextTool=([a-z_]+)(?: serviceId=([A-Za-z0-9-]+))?/.exec(text);
  const nextTool = match?.[1];
  if (!nextTool) return undefined;
  const serviceId = match?.[2];
  return serviceId ? { nextTool, serviceId } : { nextTool };
}
