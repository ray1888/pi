import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { RetryPolicy } from "@earendil-works/pi-ai";
import { messageText, toolCallsIn } from "./inspect.js";
import { PIN } from "./pin.js";
import { createSimulatedDirectory, type SimulatedDirectory } from "./catalog.js";
import { createScriptedModel } from "./scripted-model.js";
import type { Scenario } from "./scenarios.js";
import { createReadOnlyTools } from "./tools.js";
import { TraceLog, type TraceEvent } from "./trace.js";
import { withTransportRetry } from "./transport-retry.js";
import { createTurnLimit } from "./turn-limit.js";

const SYSTEM_PROMPT = [
  "你是只读运维演示助手。",
  "健康数据全部来自进程内模拟目录，source 恒为 simulated-local，不是集群，也不是生产告警。",
  "只能调用已经注册的 list_services 和 get_service_health。没有 shell，不能修改服务。",
  "工具返回错误时，根据错误改参数或停止。不要发明重试策略去重复同一次失败。",
  "拿到模拟结果后用一句话说明并停止。",
].join("\n");

export interface RunReport {
  readonly scenarioId: string;
  readonly messages: readonly AgentMessage[];
  readonly trace: readonly TraceEvent[];
  readonly jsonl: string;
  readonly fauxCalls: number;
  readonly stopReason: string;
  readonly directory: SimulatedDirectory;
}

export async function runScenario(scenario: Scenario): Promise<RunReport> {
  const trace = new TraceLog();
  const directory = createSimulatedDirectory();
  const scripted = createScriptedModel(scenario.responses);
  const tools = createReadOnlyTools({
    directory,
    retry: scenario.retry,
    onAttempt: (record) => trace.push({ type: "tool_attempt", ...record }),
  });
  const turnLimit = { maxTurns: scenario.maxTurns, hitCap: false, onTurn, onCap };
  function onTurn(index: number, stopReason: string): void {
    trace.push({ type: "turn", index, stopReason });
  }
  function onCap(_turns: number): void {
    trace.push({ type: "stop", reason: "max_turns" });
  }

  let streamFn = scripted.streamFn;
  if (scenario.transport.enabled) {
    const policy: RetryPolicy = {
      enabled: true,
      maxRetries: scenario.transport.maxRetries,
      baseDelayMs: scenario.transport.baseDelayMs,
    };
    streamFn = withTransportRetry(scripted.streamFn, {
      policy,
      onRetry: (attempt, maxAttempts, delayMs, errorMessage) => {
        trace.push({ type: "transport_retry", attempt, maxAttempts, delayMs, errorMessage });
      },
    });
  }

  trace.push({
    type: "run_start",
    scenario: scenario.id,
    modelAdapter: scripted.adapter,
    piAgentCore: PIN.agentVersion,
    data: "simulated-local",
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: scripted.model,
      tools,
    },
    streamFn,
    toolExecution: "sequential",
    finishTurn: createTurnLimit(turnLimit),
  });

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      const calls = toolCallsIn(event.message);
      const callText = calls.map((call) => `${call.name} ${JSON.stringify(call.args)}`).join(" ");
      trace.push({
        type: "message_end",
        role: event.message.role,
        ...(event.message.role === "assistant" ? { stopReason: event.message.stopReason } : {}),
        ...(event.message.role === "toolResult" ? { isError: event.message.isError === true, toolName: event.message.toolName } : {}),
        text: messageText(event.message) || callText,
      });
    }
    if (event.type === "tool_execution_start") {
      trace.push({ type: "tool_execution_start", toolName: event.toolName, args: event.args });
      if (scenario.abortAfterToolStartMs !== undefined) {
        const delay = scenario.abortAfterToolStartMs;
        setTimeout(() => agent.abort(), delay);
      }
    }
    if (event.type === "tool_execution_end") {
      trace.push({
        type: "tool_execution_end",
        toolName: event.toolName,
        isError: event.isError,
        text: messageText(event.result),
      });
    }
  });

  await agent.prompt(scenario.user);
  const stopReason = describeStop(turnLimit.hitCap, agent.state.messages);
  if (!turnLimit.hitCap) trace.push({ type: "stop", reason: stopReason });

  return {
    scenarioId: scenario.id,
    messages: agent.state.messages,
    trace: trace.events,
    jsonl: trace.toJsonl(),
    fauxCalls: scripted.faux.state.callCount,
    stopReason,
    directory,
  };
}

function describeStop(hitCap: boolean, messages: readonly AgentMessage[]): string {
  if (hitCap) return "max_turns";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "error") return "provider_error";
    return "completed";
  }
  return "completed";
}
