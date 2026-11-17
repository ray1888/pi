import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { attemptCount, messageText, systemToolNames, toolCallsIn, toolResultsIn } from "../src/inspect.js";
import { PIN } from "../src/pin.js";
import { scenarioById } from "../src/scenarios.js";
import { READ_ONLY_TOOL_NAMES } from "../src/tools.js";
import { runScenario, type RunReport } from "../src/run.js";

describe("pinned pi packages", () => {
  it("installs pi-agent-core, pi-ai, and pi-schema at 1.5.2", () => {
    assert.equal(packageVersion("@earendil-works/pi-agent-core"), PIN.agentVersion);
    assert.equal(packageVersion("@earendil-works/pi-ai"), "1.5.2");
    assert.equal(packageVersion("@earendil-works/pi-schema"), "1.5.2");
  });
});

describe("real Agent loop, scripted faux model, simulated catalog", () => {
  it("success: schema, one tool call, simulated health, then stop", async () => {
    const report = await run("success");
    assert.equal(report.stopReason, "completed");
    assert.deepEqual(systemToolNames(report.messages), [...READ_ONLY_TOOL_NAMES]);
    assert.partialDeepStrictEqual(report.trace[0], {
      type: "run_start",
      modelAdapter: "scripted-faux-not-a-real-llm",
      data: "simulated-local",
    });
    const results = toolResultsIn(report.messages);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, false);
    assert.ok(results[0]?.text.includes("simulated-local"));
    assert.ok(results[0]?.text.includes("checkout-api"));
    assert.equal(attemptCount(results[0]?.details), 1);
    assert.equal(report.directory.totalReads(), 1);
    assert.deepEqual(names(report), ["get_service_health"]);
  });

  it("transient tool failure recovers inside execute; the model is called once for the tool", async () => {
    const report = await run("transient-tool");
    assert.equal(report.stopReason, "completed");
    const results = toolResultsIn(report.messages);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, false);
    assert.equal(attemptCount(results[0]?.details), 3);
    assert.deepEqual(outcomes(report, "get_service_health"), ["retryable", "retryable", "ok"]);
    assert.equal(report.directory.readsOf("inventory"), 3);
    assert.equal(report.fauxCalls, 2);
  });

  it("unknown service is terminal and is not retried", async () => {
    const report = await run("terminal-no-retry");
    assert.equal(report.stopReason, "completed");
    const results = toolResultsIn(report.messages);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true);
    assert.ok(results[0]?.text.includes("terminal code=unknown_service"));
    assert.ok(report.messages.some((message) => message.role === "assistant" && messageText(message).includes("不重试")));
    assert.equal(attemptCount(results[0]?.details), 1);
    assert.deepEqual(outcomes(report, "get_service_health"), ["terminal"]);
    assert.equal(report.directory.totalReads(), 0);
  });

  it("retryable upstream errors stop at the attempt cap", async () => {
    const report = await run("retry-exhausted");
    assert.equal(report.stopReason, "completed");
    const results = toolResultsIn(report.messages);
    assert.equal(results.length, 1);
    assert.ok(results[0]?.text.includes("retry_exhausted code=simulated_upstream_503 attempts=3"));
    assert.deepEqual(outcomes(report, "get_service_health"), ["retryable", "retryable", "retryable"]);
    assert.equal(report.directory.readsOf("ledger"), 3);
    assert.equal(report.fauxCalls, 2);
  });

  it("a timed-out attempt is retried, then a fast read succeeds", async () => {
    const report = await run("timeout-then-ok");
    assert.equal(report.stopReason, "completed");
    assert.deepEqual(outcomes(report, "get_service_health"), ["timeout", "ok"]);
    const results = toolResultsIn(report.messages);
    assert.equal(results[0]?.isError, false);
    assert.ok(results[0]?.text.includes("slow-then-fast"));
    assert.equal(report.directory.readsOf("slow-then-fast"), 2);
  });

  it("abort during a slow read does not start another attempt", async () => {
    const started = Date.now();
    const report = await run("cancel");
    assert.ok(Date.now() - started < 2_000);
    assert.equal(report.stopReason, "aborted");
    const attempts = report.trace.filter((event) => event.type === "tool_attempt");
    assert.ok(attempts.length <= 1);
    assert.equal(
      attempts.some((event) => event.type === "tool_attempt" && event.outcome === "ok"),
      false,
    );
    const results = toolResultsIn(report.messages);
    assert.equal(results[0]?.isError, true);
    const text = results[0]?.text ?? "";
    assert.ok(text.includes("cancelled") || text.includes("Operation aborted"));
  });

  it("the scripted model changes serviceId after it sees unknown_service", async () => {
    const report = await run("model-fixes-args");
    assert.equal(report.stopReason, "completed");
    const calls = toolCallsInMessages(report);
    assert.deepEqual(
      calls.map((call) => call.args),
      [{ serviceId: "no-such-service" }, { serviceId: "checkout-api" }],
    );
    const results = toolResultsIn(report.messages);
    assert.equal(results[0]?.isError, true);
    assert.ok(results[0]?.text.includes("unknown_service"));
    assert.equal(attemptCount(results[0]?.details), 1);
    assert.equal(results[1]?.isError, false);
    assert.ok(results[1]?.text.includes("checkout-api"));
  });

  it("invalid arguments never enter execute; the next turn supplies serviceId", async () => {
    const report = await run("schema-then-fix");
    assert.equal(report.stopReason, "completed");
    const results = toolResultsIn(report.messages);
    assert.equal(results[0]?.isError, true);
    assert.ok(results[0]?.text.includes("Validation failed"));
    assert.equal(attemptCount(results[0]?.details), 0);
    assert.equal(results[1]?.isError, false);
    assert.equal(report.directory.totalReads(), 1);
    assert.equal(report.trace.filter((event) => event.type === "tool_attempt").length, 1);
  });

  it("bash is not registered and does not touch the catalog", async () => {
    const report = await run("unknown-tool");
    assert.equal(report.stopReason, "completed");
    const results = toolResultsIn(report.messages);
    assert.equal(results[0]?.toolName, "bash");
    assert.ok(results[0]?.text.includes("Tool bash not found"));
    assert.equal(report.directory.totalReads(), 0);
    assert.equal(
      report.trace.some((event) => event.type === "tool_attempt"),
      false,
    );
  });

  it("a model that keeps calling tools stops at max turns", async () => {
    const report = await run("turn-cap");
    assert.equal(report.stopReason, "max_turns");
    assert.equal(toolResultsIn(report.messages).length, 3);
    assert.equal(report.fauxCalls, 3);
    assert.equal(report.trace.filter((event) => event.type === "turn").length, 3);
  });

  it("retryAssistantCall hides one scripted 503, then the agent loop still runs the tool", async () => {
    const report = await run("transport-recovers");
    assert.equal(report.stopReason, "completed");
    const retries = report.trace.filter((event) => event.type === "transport_retry");
    assert.equal(retries.length, 1);
    assert.partialDeepStrictEqual(retries[0], { attempt: 1, maxAttempts: 2 });
    const results = toolResultsIn(report.messages);
    assert.equal(results.length, 1);
    assert.ok(results[0]?.text.includes("checkout-api"));
    assert.equal(report.fauxCalls, 3);
  });

  it("a non-retryable provider error is not retried and does not call tools", async () => {
    const report = await run("transport-not-retryable");
    assert.equal(report.stopReason, "provider_error");
    assert.equal(report.fauxCalls, 1);
    assert.equal(report.trace.filter((event) => event.type === "transport_retry").length, 0);
    assert.equal(toolResultsIn(report.messages).length, 0);
    assert.equal(report.directory.totalReads(), 0);
  });

  it("retryable provider errors stop after the configured retries", async () => {
    const report = await run("transport-exhausted");
    assert.equal(report.stopReason, "provider_error");
    assert.equal(report.fauxCalls, 3);
    assert.equal(report.trace.filter((event) => event.type === "transport_retry").length, 2);
    assert.equal(toolResultsIn(report.messages).length, 0);
  });
});

async function run(id: string): Promise<RunReport> {
  const scenario = scenarioById(id);
  if (!scenario) throw new Error(`missing scenario ${id}`);
  return runScenario(scenario);
}

function names(report: RunReport): string[] {
  return toolCallsInMessages(report).map((call) => call.name);
}

function toolCallsInMessages(report: RunReport): { name: string; args: unknown }[] {
  return report.messages.flatMap((message) => toolCallsIn(message));
}

function outcomes(report: RunReport, tool: string): string[] {
  return report.trace.flatMap((event) =>
    event.type === "tool_attempt" && event.tool === tool ? [event.outcome] : [],
  );
}

function packageVersion(name: string): string {
  const path = fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url));
  return versionOf(JSON.parse(readFileSync(path, "utf8")));
}

function versionOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "version" in value && typeof value.version === "string") {
    return value.version;
  }
  throw new Error("package.json 缺少 version");
}
