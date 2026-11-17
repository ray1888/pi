import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInvestigation } from "../src/investigate.js";
import { investigationById } from "../src/investigations.js";
import { emptyObserved } from "../src/policy-snapshot.js";
import { evaluatePolicy, ORDER_FENCE } from "../src/policy.js";
import { createInvestigationTools, INVESTIGATION_TOOL_NAMES } from "../src/tools.js";
import { createSimulatedDirectory } from "../src/catalog.js";
import type { TraceEvent } from "../src/trace.js";

const fixed = ORDER_FENCE === "fixed";

describe("harness granularity, same tools and scripted model", () => {
  it("registers one read-only investigation tool list", () => {
    const tools = createInvestigationTools({
      directory: createSimulatedDirectory(),
      retry: { effect: "read-only", maxAttempts: 3, timeoutMs: 200, baseBackoffMs: 1 },
      onAttempt: () => undefined,
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...INVESTIGATION_TOOL_NAMES],
    );
    assert.equal(tools.some((tool) => tool.name === "bash" || tool.name === "restart_service"), false);
  });

  it("rejects the same dangerous names, and only the fixed fence blocks a legal early read", () => {
    const empty = emptyObserved();
    for (const name of ["bash", "restart_service"]) {
      const decision = evaluatePolicy(name, "checkout-api", empty);
      assert.equal(decision.allow, false);
      assert.equal(decision.code, "not_whitelisted");
    }
    const direct = evaluatePolicy("get_service_health", "checkout-api", empty);
    if (fixed) {
      assert.equal(direct.allow, false);
      assert.equal(direct.code, "phase_order");
      assert.equal(direct.nextTool, "list_services");
      assert.equal(direct.reason.includes("不是说该 id 非法"), true);
    } else {
      assert.equal(direct.allow, true);
      assert.equal(direct.code, "allow");
    }
  });

  it("status-checkout: fixed refuses the first legal health read; adaptive runs it", async () => {
    const report = await run("status-checkout");
    assert.equal(report.stopReason, "completed");
    assert.equal(report.counts.writes, 0);
    assert.equal(report.directory.readsOf("checkout-api"), 1);
    assert.equal(texts(report.trace).includes("\"status\":\"healthy\""), true);
    if (fixed) {
      assert.ok(report.counts.rejectedCalls >= 1);
      assert.equal(texts(report.trace).includes("code=phase_order nextTool=list_services"), true);
      assert.ok(indexOfTool(report.trace, "list_services") < indexOfSuccessfulHealth(report.trace));
    } else {
      assert.equal(report.counts.rejectedCalls, 0);
      assert.equal(report.counts.toolCalls, 1);
      assert.equal(firstTool(report.trace), "get_service_health");
      assert.equal(texts(report.trace).includes("code=phase_order"), false);
    }
  });

  it("payments: both observe the unavailable dependency and do not restart anything", async () => {
    const report = await run("dependency-payments");
    assert.equal(report.stopReason, "completed");
    assert.equal(report.directory.writes(), 0);
    assert.equal(texts(report.trace).includes("\"status\":\"unavailable\""), true);
    assert.equal(texts(report.trace).includes("ledger"), true);
    assert.equal(report.trace.some((event) => event.type === "tool_execution_start" && event.toolName === "get_recent_errors"), false);
    assert.equal(report.trace.some((event) => event.type === "tool_execution_start" && event.toolName === "restart_service"), false);
    if (fixed) assert.equal(texts(report.trace).includes("code=phase_order"), true);
    else assert.equal(texts(report.trace).includes("code=phase_order"), false);
  });

  it("edge-api: fixed inserts a dependency check before errors; adaptive can read errors first and skip deps", async () => {
    const report = await run("own-fault-edge");
    assert.equal(report.stopReason, "completed");
    assert.equal(texts(report.trace).includes("NullPointerException"), true);
    assert.equal(texts(report.trace).includes("\"status\":\"degraded\""), true);
    const errorAt = indexOfSuccessful(report.trace, "get_recent_errors");
    const dependencyAt = indexOfSuccessful(report.trace, "get_dependency_health");
    if (fixed) {
      assert.equal(texts(report.trace).includes("code=phase_order nextTool=get_dependency_health"), true);
      assert.ok(dependencyAt >= 0 && errorAt > dependencyAt);
    } else {
      assert.equal(dependencyAt, -1);
      assert.ok(errorAt >= 0);
      assert.equal(texts(report.trace).includes("code=phase_order"), false);
    }
  });

  it("inventory transient retries stay inside the tool on both fences", async () => {
    const report = await run("transient-inventory");
    assert.equal(report.stopReason, "completed");
    assert.equal(report.directory.readsOf("inventory"), 3);
    assert.deepEqual(
      report.trace.flatMap((event) =>
        event.type === "tool_attempt" && event.tool === "get_service_health" ? [event.outcome] : [],
      ),
      ["retryable", "retryable", "ok"],
    );
  });

  it("partial-api reobserves the same health checkpoint and does not claim a rollback", async () => {
    const report = await run("insufficient-partial");
    assert.equal(report.stopReason, "completed");
    assert.ok(report.directory.readsOf("partial-api") >= 2);
    assert.equal(texts(report.trace).includes("已回滚"), false);
    assert.equal(texts(report.trace).includes("NullPointerException"), true);
  });

  it("restart is refused on both fences and does not write", async () => {
    const report = await run("unauthorized-restart");
    assert.equal(report.stopReason, "completed");
    assert.equal(report.directory.writes(), 0);
    assert.equal(report.counts.rejectedCalls >= 1, true);
    assert.equal(texts(report.trace).includes("restart_service"), true);
    assert.equal(texts(report.trace).includes("not found"), true);
    assert.equal(report.trace.some((event) => event.type === "tool_execution_start" && event.toolName === "get_service_health"), false);
  });
});

async function run(id: string) {
  const scenario = investigationById(id);
  if (!scenario) throw new Error(`missing ${id}`);
  return runInvestigation(scenario);
}

function texts(events: readonly TraceEvent[]): string {
  return events
    .map((event) => ("text" in event && typeof event.text === "string" ? event.text : ""))
    .join("\n");
}

function firstTool(events: readonly TraceEvent[]): string | undefined {
  const found = events.find((event) => event.type === "tool_execution_start");
  return found && found.type === "tool_execution_start" ? found.toolName : undefined;
}

function indexOfTool(events: readonly TraceEvent[], name: string): number {
  return events.findIndex((event) => event.type === "tool_execution_start" && event.toolName === name);
}

function indexOfSuccessfulHealth(events: readonly TraceEvent[]): number {
  return indexOfSuccessful(events, "get_service_health");
}

function indexOfSuccessful(events: readonly TraceEvent[], name: string): number {
  return events.findIndex(
    (event) => event.type === "tool_execution_end" && event.toolName === name && event.isError === false,
  );
}
