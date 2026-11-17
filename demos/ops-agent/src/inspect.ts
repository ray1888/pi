import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TranscriptContext } from "@earendil-works/pi-ai";

export function messageText(message: { readonly content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
      if (typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("");
}

export interface SeenToolCall {
  readonly name: string;
  readonly args: unknown;
}

export function toolCallsIn(message: AgentMessage): SeenToolCall[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: SeenToolCall[] = [];
  for (const block of message.content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "toolCall" &&
      "name" in block &&
      typeof block.name === "string"
    ) {
      calls.push({ name: block.name, args: "arguments" in block ? block.arguments : undefined });
    }
  }
  return calls;
}

export interface SeenToolResult {
  readonly text: string;
  readonly isError: boolean;
  readonly toolName: string;
  readonly details: unknown;
}

export function toolResultsIn(messages: readonly AgentMessage[]): SeenToolResult[] {
  const results: SeenToolResult[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    results.push({
      text: messageText(message),
      isError: message.isError === true,
      toolName: message.toolName,
      details: message.details,
    });
  }
  return results;
}

export function attemptCount(details: unknown): number {
  if (typeof details !== "object" || details === null || !("attempts" in details)) return 0;
  const attempts = details.attempts;
  return Array.isArray(attempts) ? attempts.length : 0;
}

export function lastToolFeedback(context: TranscriptContext): { readonly text: string; readonly isError: boolean } | undefined {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (!message || message.role !== "toolResult") continue;
    return { text: messageText(message), isError: message.isError === true };
  }
  return undefined;
}

export function systemToolNames(messages: readonly AgentMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "system" || !("toolsAdded" in message) || !Array.isArray(message.toolsAdded)) continue;
    for (const tool of message.toolsAdded) {
      if (typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string") {
        names.push(tool.name);
      }
    }
  }
  return names;
}
