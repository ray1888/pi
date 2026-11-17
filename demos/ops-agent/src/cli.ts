import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { INVESTIGATIONS, investigationById } from "./investigations.js";
import { runInvestigation } from "./investigate.js";
import { ORDER_FENCE } from "./policy.js";
import { SCENARIOS, scenarioById } from "./scenarios.js";
import { runScenario } from "./run.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
} else if (args.includes("--write-examples")) {
  await writeExamples();
} else if (args.includes("--investigate-traces")) {
  await writeInvestigations();
} else if (args[0] === "--investigate" && args[1]) {
  await runInvestigationCli(args[1]);
} else if (args[0] === "--live") {
  await runLive(args.slice(1).join(" ").trim());
} else if (args.length === 1 && args[0]) {
  await runOne(args[0]);
} else {
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  const ids = SCENARIOS.map((scenario) => `  ${scenario.id}  ${scenario.title}`).join("\n");
  process.stderr.write(
    [
      "离线演示（脚本模型，不访问集群，不需要密钥）：",
      "  npm test",
      "  npm run demo -- success",
      "  npm run traces",
      "  npm run investigate -- status-checkout",
      `当前顺序栅栏：${ORDER_FENCE}。fixed 与 adaptive 的差别只在 src/policy.ts 的 orderFence。`,
      "",
      "场景：",
      ids,
      "",
      "可选真实模型（不会在测试里运行）：",
      "  OPENAI_API_KEY=... npm run demo -- --live 看一下 checkout-api",
      "",
    ].join("\n"),
  );
}

async function runOne(id: string): Promise<void> {
  const scenario = scenarioById(id);
  if (!scenario) {
    process.stderr.write(`未知场景 ${id}\n`);
    process.exitCode = 1;
    return;
  }
  const report = await runScenario(scenario);
  process.stdout.write(report.jsonl);
  process.stderr.write(`${report.scenarioId} stop=${report.stopReason} fauxCalls=${report.fauxCalls}\n`);
}

async function writeExamples(): Promise<void> {
  for (const scenario of SCENARIOS) {
    const report = await runScenario(scenario);
    const path = resolve("examples/traces", `${scenario.id}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, report.jsonl);
    process.stderr.write(`wrote ${path} stop=${report.stopReason}\n`);
  }
}

async function runInvestigationCli(id: string): Promise<void> {
  const scenario = investigationById(id);
  if (!scenario) {
    process.stderr.write(`未知排查场景 ${id}\n`);
    process.exitCode = 1;
    return;
  }
  const report = await runInvestigation(scenario);
  process.stdout.write(report.jsonl);
  const counts = report.counts;
  process.stderr.write(
    `${report.scenarioId} fence=${report.orderFence} stop=${report.stopReason} toolCalls=${counts.toolCalls} modelTurns=${counts.modelTurns} executeAttempts=${counts.executeAttempts} rejectedCalls=${counts.rejectedCalls} writes=${counts.writes}\n`,
  );
}

async function writeInvestigations(): Promise<void> {
  for (const scenario of INVESTIGATIONS) {
    const report = await runInvestigation(scenario);
    const path = resolve("examples/traces/ab", `${scenario.id}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, report.jsonl);
    process.stderr.write(`wrote ${path} fence=${report.orderFence} stop=${report.stopReason}\n`);
  }
}

async function runLive(prompt: string): Promise<void> {
  if (!prompt) {
    throw new Error("用法：npm run demo -- --live 你的问题");
  }
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { loadLiveModel } = await import("./live-model.js");
  const { createSimulatedDirectory } = await import("./catalog.js");
  const { createReadOnlyTools } = await import("./tools.js");
  const { createTurnLimit } = await import("./turn-limit.js");
  const live = await loadLiveModel();
  const directory = createSimulatedDirectory();
  const agent = new Agent({
    initialState: {
      systemPrompt: "你是只读运维演示助手。只能用 list_services 和 get_service_health。数据是 simulated-local，不是集群。不要使用 shell。",
      model: live.model,
      tools: createReadOnlyTools({
        directory,
        retry: { effect: "read-only", maxAttempts: 3, timeoutMs: 1_000, baseBackoffMs: 20 },
        onAttempt: (record) => {
          process.stderr.write(`tool_attempt ${record.tool} ${record.attempt}/${record.maxAttempts} ${record.outcome} ${record.code}\n`);
        },
      }),
    },
    streamFn: live.streamFn,
    toolExecution: "sequential",
    finishTurn: createTurnLimit({
      maxTurns: 4,
      hitCap: false,
      onTurn: () => undefined,
      onCap: () => process.stderr.write("stop max_turns\n"),
    }),
  });
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await agent.prompt(prompt);
  process.stdout.write("\n");
}
