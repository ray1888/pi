import { messageText } from "./inspect.js";

export interface HealthObservation {
  readonly status: string;
  readonly symptom: string;
}

export interface DependencyObservation {
  readonly unhealthy: readonly string[];
}

export interface ErrorObservation {
  readonly ownException: boolean;
}

export interface Observed {
  listed: boolean;
  readonly health: Map<string, HealthObservation>;
  readonly dependencies: Map<string, DependencyObservation>;
  readonly errors: Map<string, ErrorObservation>;
}

export function emptyObserved(): Observed {
  return { listed: false, health: new Map(), dependencies: new Map(), errors: new Map() };
}

export interface ObservationMessage {
  readonly role: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly content?: unknown;
}

export function observeMessages(messages: readonly ObservationMessage[]): Observed {
  const observed = emptyObserved();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError === true || !message.toolName) continue;
    absorb(message.toolName, messageText(message), observed);
  }
  return observed;
}

function absorb(toolName: string, text: string, observed: Observed): void {
  const parsed = parseJson(text);
  if (toolName === "list_services") {
    observed.listed = true;
    return;
  }
  if (!parsed) return;
  const serviceId = stringField(parsed, "serviceId");
  if (!serviceId) return;
  if (toolName === "get_service_health") {
    const status = stringField(parsed, "status");
    const symptom = stringField(parsed, "symptom");
    if (status && symptom) observed.health.set(serviceId, { status, symptom });
    return;
  }
  if (toolName === "get_dependency_health") {
    observed.dependencies.set(serviceId, { unhealthy: unhealthyIds(parsed) });
    return;
  }
  if (toolName === "get_recent_errors") {
    observed.errors.set(serviceId, { ownException: linesOf(parsed).some((line) => line.includes("Exception")) });
  }
}

function unhealthyIds(value: Record<string, unknown>): string[] {
  const dependencies = value.dependencies;
  if (!Array.isArray(dependencies)) return [];
  const ids: string[] = [];
  for (const item of dependencies) {
    if (typeof item !== "object" || item === null) continue;
    if (!("id" in item) || !("status" in item)) continue;
    if (typeof item.id === "string" && item.status === "unavailable") ids.push(item.id);
  }
  return ids;
}

function linesOf(value: Record<string, unknown>): string[] {
  const lines = value.lines;
  if (!Array.isArray(lines)) return [];
  return lines.filter((line): line is string => typeof line === "string");
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
    return undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}
