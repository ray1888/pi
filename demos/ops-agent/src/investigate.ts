import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText, toolCallsIn } from "./inspect.js";
import { PIN } from "./pin.js";
import { createSimulatedDirectory, type SimulatedDirectory } from "./catalog.js";
import { createScriptedModel } from "./scripted-model.js";
import { evaluatePolicy, ORDER_FENCE, serviceIdOf } from "./policy.js";
import { observeMessages } from "./policy-snapshot.js";
import { reactiveResponses } from "./reactive-model.js";
import { createInvestigationTools } from "./tools.js";
import { TraceLog, type TraceEvent } from "./trace.js";
import { createTurnLimit } from "./turn-limit.js";

const SYSTEM_PROMPT = [
  "你是只读运维演示助手。数据全部是 simulated-local，不是集群。",
  "只能使用 list_services、get_service_health、get_dependency_health、get_recent_errors。",
  "没有 shell，不能重启或修改服务。",
  "如果工具返回 code=phase_order，下一步调用其中的 nextTool。这是顺序约束，不是该服务 id 非法。",
  "证据不足时重新观察同一步。模拟读取没有外部副作用，不能声称已经回滚。",
].join("\n");

export interface InvestigationCase {
  readonly id: string;
  readonly title: string;
  readonly user: string;
}

export interface InvestigationReport {
  readonly scenarioId: string;
  readonly orderFence: typeof ORDER_FENCE;
  readonly messages: readonly AgentMessage[];
  readonly trace: readonly TraceEvent[];
  readonly jsonl: string;
  readonly stopReason: string;
  readonly directory: SimulatedDirectory;
  readonly counts: InvestigationCounts;
}

export interface InvestigationCounts {
  readonly toolCalls: number;
  readonly modelTurns: number;
  readonly executeAttempts: number;
  readonly rejectedCalls: number;
  readonly writes: number;
}

const RETRY = { effect: "read-only" as const, maxAttempts: 3, timeoutMs: 200, baseBackoffMs: 1 };

export async function runInvestigation(scenario: InvestigationCase): Promise<InvestigationReport> {
  const trace = new TraceLog();
  const directory = createSimulatedDirectory();
  const scripted = createScriptedModel(reactiveResponses(12));
  const tools = createInvestigationTools({
    directory,
    retry: RETRY,
    onAttempt: (record) => trace.push({ type: "tool_attempt", ...record }),
  });
  const turnLimit = { maxTurns: 10, hitCap: false, onTurn, onCap };
  function onTurn(index: number, stopReason: string): void {
    trace.push({ type: "turn", index, stopReason });
  }
  function onCap(): void {
    trace.push({ type: "stop", reason: "max_turns" });
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
    streamFn: scripted.streamFn,
    toolExecution: "sequential",
    finishTurn: createTurnLimit(turnLimit),
    beforeToolCall: async ({ toolCall, args, context }) => {
      const decision = evaluatePolicy(toolCall.name, serviceIdOf(args), observeMessages(context.messages));
      if (!decision.allow) return { block: true, reason: decision.reason };
      return undefined;
    },
  });

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      const calls = toolCallsIn(event.message);
      const callText = calls.map((call) => `${call.name} ${JSON.stringify(call.args)}`).join(" ");
      trace.push({
        type: "message_end",
        role: event.message.role,
        ...(event.message.role === "assistant" ? { stopReason: event.message.stopReason } : {}),
        ...(event.message.role === "toolResult"
          ? { isError: event.message.isError === true, toolName: event.message.toolName }
          : {}),
        text: messageText(event.message) || callText,
      });
    }
    if (event.type === "tool_execution_start") {
      trace.push({ type: "tool_execution_start", toolName: event.toolName, args: event.args });
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
  const counts = countTrace(trace.events, directory.writes());
  trace.push({
    type: "stop",
    reason: `summary toolCalls=${counts.toolCalls} modelTurns=${counts.modelTurns} executeAttempts=${counts.executeAttempts} rejectedCalls=${counts.rejectedCalls} writes=${counts.writes} orderFence=${ORDER_FENCE}`,
  });

  return {
    scenarioId: scenario.id,
    orderFence: ORDER_FENCE,
    messages: agent.state.messages,
    trace: trace.events,
    jsonl: trace.toJsonl(),
    stopReason,
    directory,
    counts,
  };
}

function countTrace(events: readonly TraceEvent[], writes: number): InvestigationCounts {
  let toolCalls = 0;
  let modelTurns = 0;
  let executeAttempts = 0;
  let rejectedCalls = 0;
  for (const event of events) {
    if (event.type === "tool_execution_start") toolCalls += 1;
    if (event.type === "turn") modelTurns += 1;
    if (event.type === "tool_attempt") executeAttempts += 1;
    if (event.type === "tool_execution_end" && event.isError) {
      if (
        event.text.includes("code=phase_order") ||
        event.text.includes("code=not_whitelisted") ||
        event.text.includes("not found")
      ) {
        rejectedCalls += 1;
      }
    }
  }
  return { toolCalls, modelTurns, executeAttempts, rejectedCalls, writes };
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
