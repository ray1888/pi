/** 与 package.json、npm 上的 1.5.2 发布提交对齐。main 在此之后还有提交，demo 不跟踪 main。 */
export const PIN = {
  agentPackage: "@earendil-works/pi-agent-core",
  agentVersion: "1.5.2",
  piCommit: "b4afdddf44e059c67ccf5097e5317d913521b470",
  piRepo: "https://github.com/earendil-works/pi",
  holmesCommit: "927b4aaad0a555ba118d3afe15ce264b3b131e41",
  holmesRepo: "https://github.com/HolmesGPT/holmesgpt",
  modelAdapter: "scripted-faux-not-a-real-llm",
} as const;

export const BOUNDS = {
  maxToolAttempts: 5,
  maxTurns: 12,
  maxBackoffMs: 50,
  maxTimeoutMs: 2_000,
} as const;
