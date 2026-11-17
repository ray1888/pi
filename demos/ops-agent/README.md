这个目录是 https://github.com/ray1888/pi 里的自包含 demo。Git 分支从该 fork 的 main（5f89cc0a7df669813650bfdac498f8ff865e8233）单独长出，只增加本目录，不改 Pi 核心、仓库根或 CI。npm 依赖仍钉在 @earendil-works/pi-agent-core 1.5.2，不跟随 fork main 上更新的 Pi 源码。

# 用 Pi agent 跑通的只读运维 demo

这是一个给有编程经验的 SRE 看的最小示例：用已发布的 `@earendil-works/pi-agent-core@1.5.2` 真正执行 agent 循环，工具只读本地**模拟**健康目录。默认测试不需要密钥，不访问模型 API，也不访问集群。

本目录当前 `ORDER_FENCE=adaptive`。共同基线不额外限制只读工具的顺序。`fixed` 与 `adaptive` 两个分支只替换 `orderFence`。工具定义、模拟数据、依赖版本、重试上限、取消、超时和轮次预算相同。脚本模型同一份，只能证明控制流，不能证明真实模型谁更会排查。这里不记录 token 或费用。

第一条要跑的命令：

```bash
npm ci
npm test
npm run investigate -- status-checkout
```

对比两个分支时，在包含两边的仓库里看：

```bash
git diff <fixed-branch>...<adaptive-branch> -- demos/ops-agent/src/policy.ts
```

`fixed` 会在还没列出目录时拒绝合法的 `get_service_health`，理由是顺序而不是该 id 非法。`adaptive` 允许这次读取。两边都会拒绝 `bash` 和 `restart_service`。拒绝早读可能是合理的清单约束：它让同一次排查先有目录快照，也会挡住已经点名的直接读取。

Node.js 需要 `>= 22.19`（本仓库在 Node `v22.23.4`、npm `10.9.9` 上跑通）。通过后再看一条轨迹：

```bash
npm run demo -- success
```

标准输出就是 JSONL。同内容也在 `examples/traces/success.jsonl`。

## 项目识别

通用 Pi agent 指 GitHub 仓库 [earendil-works/pi](https://github.com/earendil-works/pi)（仓库数字 id `1035029907`）。用 GitHub API 查询 `badlogic/pi-mono` 时返回的是同一个 id、同一个 `full_name: earendil-works/pi`。它不是第二个实现。本 demo 固定使用该仓库 **Release v1.5.2** 的提交 [`b4afdddf44e059c67ccf5097e5317d913521b470`](https://github.com/earendil-works/pi/commit/b4afdddf44e059c67ccf5097e5317d913521b470)（2026-11-10）。`main` 在这之后还有提交（例如 2026-11-13 的 `4438c58`），那些改动不在 npm `1.5.2` 里，这里不跟。

嵌进去的包是：

| 包 | 版本 | 作用 |
| --- | --- | --- |
| `@earendil-works/pi-agent-core` | 1.5.2 | `Agent` 循环、工具执行、事件 |
| `@earendil-works/pi-ai` | 1.5.2 | 模型流、`fauxProvider`、传输层重试辅助函数 |
| `@earendil-works/pi-schema` | 1.5.2 | 工具参数 JSON Schema |

没有采用下面这些名字相近、接口不同的项目：

- [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 是另一套带 IDE 的编码 agent（仓库 id `1125856365`），不是这个可嵌入的 `Agent` 循环。
- [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) 是语音框架，只是名字前缀像。

如果目标其实是 oh-my-pi，需要另开实现；它的工具注册接口和这里的 `AgentTool` 不是同一套。

HolmesGPT 只作对照，代码没有复制进来。核对的是官方仓库 [HolmesGPT/holmesgpt](https://github.com/HolmesGPT/holmesgpt) 的 `master` 提交 [`927b4aaad0a555ba118d3afe15ce264b3b131e41`](https://github.com/HolmesGPT/holmesgpt/commit/927b4aaad0a555ba118d3afe15ce264b3b131e41)（2026-11-17）。没有把某个能力说成只有它有。

## 三层别混在一起

一次“失败后再试”可能发生在三个不同的地方。

### 1. 模型 API / 传输重试

Pi 的 `Agent` 循环**不会**在 `streamAssistantResponse` 里自动重试。该函数对 `streamFn` 只取一次结果：

- 源码：[`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts) 的 `streamAssistantResponse`
- 失败约定：`StreamFn` 不能抛请求错误，要做成 `stopReason: "error" | "aborted"` 的 assistant 消息（[`types.ts`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/types.ts) 里的 `StreamFn`）

传输重试在 `@earendil-works/pi-ai`：

- [`retryProviderRequest`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/ai/src/utils/provider-retry.ts)：重试单次 HTTP/SDK 请求。默认可重试状态包括 408、409、429 和 `>= 500`。`maxRetries` 默认是 0，由 provider 调用时传入。睡眠能被 `AbortSignal` 打断。
- [`retryAssistantCall` / `isRetryableAssistantError`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/ai/src/utils/retry.ts)：整次 assistant 调用结束后，若 `stopReason === "error"` 且 `errorMessage` 像暂时故障（例如正文里的 `503`），再调用一次 produce。配额类文案（如 `insufficient_quota`）先被排除。abort 不重试。

Holmes 对应的是 LLM 调用，不是工具执行。[`call_with_rate_limit_retry`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/llm_rate_limit.py) 用 tenacity 包住一次 `fn`。文件头写明：retry 重复的是一次 LLM call，不是整次排查。`ToolCallingLLM.call` 在 `llm.completion` 外包了 `rate_limit_retry_scope`（[`tool_calling_llm.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tool_calling_llm.py)）。分类函数是 `is_retryable_llm_error`：限流、过载、503，且不是配额耗尽。

本 demo 的 `src/transport-retry.ts` 只在脚本故障场景里调用 `retryAssistantCall`。真实 provider 自己的客户端已经会走 `retryProviderRequest`，可选的 `--live` 路径**不再**套这一层，避免双重重试。

### 2. 工具执行重试

Pi 对一次 tool call 只 `execute` 一次。[`executePreparedToolCall`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts) 接住抛出的异常，变成 `isError: true` 的 tool result。参数在执行前由 [`validateToolArguments`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/ai/src/utils/validation.ts) 校验；校验失败不会进入 `execute`。

Holmes 的 [`Tool.invoke`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tools.py) 对一次调用做参数强制转换然后 `_invoke` 一次。`YAMLTool._invoke` 跑一条命令或脚本，非 0 退出变成 `ERROR`。[`ToolCallingLLM._invoke_llm_tool_call`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tool_calling_llm.py) 解析 JSON 参数、找到工具、调用一次，再把结果写回对话。已读路径上没有“同一 tool call 自动再执行 N 次”。MCP 工具集加载失败时的 “Holmes will retry automatically” 指的是 toolset 初始化，不是单次工具调用。没有把每个插件都读完，不能声称所有 Holmes 工具内部都没有自己的重试。

`src/tool-retry.ts` 的 `withReadOnlyRetry` 是 **demo 自己的只读工具策略**，不是框架功能。它包在 `execute` 里面，所以模型只看见最终成功或 `retry_exhausted`。轨迹里的 `tool_attempt` 才能看到中间次数。

可重试：`retryable`（模拟 503）、`timeout`。不可重试：`terminal`（未知服务、意外错误）、`cancelled`。次数上限 1–5，单次超时上限 2000ms，退避 `base * 2^(attempt-1)` 且不超过 50ms。取消发生在等待或退避时，不再开始下一次 attempt。

### 3. 模型看见错误后再决定

这不是重试框架，是下一轮推理。Pi 的 `runLoop` 在本批工具结果没有全部带 `terminate: true` 时继续请求模型。错误或 abort 的 assistant 消息会直接结束本轮 run。Holmes 用 `while i < max_steps`，最后一轮把 `tools` 设成 `None`，迫使模型收束；`cancel_event` 会中断。

demo 里用 [`fauxProvider`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/ai/src/providers/faux.ts) 预先写好的回复模拟“看见 tool result 后改参数”。轨迹字段 `modelAdapter` 固定是 `scripted-faux-not-a-real-llm`。这不是 LLM，也没有集群。

Pi 循环本身没有最大轮次。`src/turn-limit.ts` 用 `finishTurn` 返回 `{ action: "end" }` 封顶（1–8）。这是 demo 的编排，对应 Holmes 的 `max_steps` 这个角色，但不是把 Holmes 的循环搬过来。

## 写操作

没有写工具，也没有 shell。`withReadOnlyRetry` 的 `effect` 只能是 `"read-only"`。

不要把这层重试套到重启、删除、扩容、发版这类非幂等动作上。第一次请求可能已经在服务端生效，只是响应丢了；再试一次就会做第二次。那种情况要先有幂等键或先查询状态，本 demo 不实现。

白名单只有两个工具，注册在 `Agent` 的 `initialState.tools` 上。未注册名字（例如 `bash`）由 `prepareToolCall` 回成 `Tool bash not found`，目录读取次数是 0。

## 文件

| 文件 | 哪一层 |
| --- | --- |
| `src/catalog.ts` | 模拟目录。每条记录都有 `source: "simulated-local"` |
| `src/tools.ts` | 工具 schema 与注册。模型看见的是系统消息上的 `toolsAdded` |
| `src/failures.ts` | 错误分类、可取消的等待 |
| `src/tool-retry.ts` | demo 的只读工具重试 |
| `src/transport-retry.ts` | 调用 pi-ai 的 `retryAssistantCall` |
| `src/turn-limit.ts` | `finishTurn` 轮次上限 |
| `src/scripted-model.ts` | `fauxProvider`，标明不是真实模型 |
| `src/scenarios.ts` | 每个场景的脚本回复 |
| `src/run.ts` | 组装 `new Agent` 并订阅事件 |
| `src/live-model.ts` | 可选真实模型。测试不会 import 它 |
| `src/cli.ts` | `npm run demo` / `npm run traces` |
| `test/agent-loop.test.ts` | 走真实 `agent.prompt` |
| `examples/traces/*.jsonl` | 可直接打开的轨迹 |

## 怎么读一条请求

以 `examples/traces/success.jsonl` 为例，一行一个事件：

1. `run_start`：确认适配器是 `scripted-faux-not-a-real-llm`，数据是 `simulated-local`。
2. `message_end` / `user`：用户问题。
3. `message_end` / `assistant` / `stopReason: toolUse`：模型要调的工具和参数。
4. `tool_execution_start`：框架开始这次 tool call，参数已经出现在 `args`。
5. `tool_attempt`：demo 工具层的第几次执行。`success` 只有 `attempt: 1, outcome: ok`。
6. `tool_execution_end` 然后 `message_end` / `toolResult`：回填给模型的正文。成功时正文含 `simulated-local`。
7. `turn`：`finishTurn` 看到的轮次。
8. 下一条 assistant `stopReason: stop`：不再要工具。
9. `stop` / `reason: completed`。

对照其他文件：

| 文件 | 你应该看到 |
| --- | --- |
| `transient-tool.jsonl` | 同一次 tool call 里 `retryable`、`retryable`、`ok`，然后才 `tool_execution_end`。模型侧只有一次 `get_service_health` |
| `terminal-no-retry.jsonl` | 一条 `outcome: terminal`，正文含 `unknown_service`，没有第二次 attempt |
| `retry-exhausted.jsonl` | 三次 `simulated_upstream_503`，正文含 `retry_exhausted ... attempts=3` |
| `timeout-then-ok.jsonl` | `timeout` 然后 `ok` |
| `cancel.jsonl` | 一条 `cancelled`，随后 assistant `stopReason: aborted` |
| `model-fixes-args.jsonl` | 先 `no-such-service` 的错误结果，下一条 assistant 改成 `checkout-api` |
| `schema-then-fix.jsonl` | 第一条 tool result 含 `Validation failed`，没有 `tool_attempt`；下一次才真正 `execute` |
| `unknown-tool.jsonl` | `Tool bash not found` |
| `turn-cap.jsonl` | 三次 `list_services` 后 `stop.reason = max_turns` |
| `transport-recovers.jsonl` | 先有 `transport_retry`（attempt 1），Agent 看到的第一条工具调用已经是恢复后的 |
| `transport-not-retryable.jsonl` | 没有 `transport_retry`，没有 tool result，`stop.reason = provider_error` |
| `transport-exhausted.jsonl` | 两条 `transport_retry`，三次脚本 503 后停止 |

会话里的系统消息还带着 `toolsAdded`。测试会检查名字就是 `list_services` 和 `get_service_health`。JSONL 没有把整份 schema 再抄一遍。

## 命令

```bash
npm ci
npm test          # node:test，约 14 项，离线
npm run typecheck # tsc --noEmit
npm run demo -- success
npm run traces    # 重写 examples/traces
```

`npm test` 在本环境的结果：14 项通过，0 失败（Node v22.23.4）。安装后的直接依赖：

```text
@earendil-works/pi-agent-core@1.5.2
@earendil-works/pi-ai@1.5.2
@earendil-works/pi-schema@1.5.2
@types/node@22.19.19
tsx@4.20.6
typescript@5.9.3
```

可选真实模型（本仓库的测试和轨迹**没有**跑过这条路径）：

```bash
OPENAI_API_KEY=你自己的密钥 npm run demo -- --live 看一下 checkout-api 的模拟健康
```

密钥只读环境变量 `OPENAI_API_KEY`，不打印、不写文件。默认模型 id 是 `gpt-4.1-mini`（`models.getModel("openai", "gpt-4.1-mini")` 能在 1.5.2 的目录里找到）。可用 `PI_OPS_DEMO_MODEL` 换成目录里的别的 id。这条路径仍只查模拟目录，但会把提示发给 OpenAI。

## 已验证 / 未验证

已验证：

- `npm ci` 之后的 `tsc --noEmit` 和 `npm test` 都在本机执行并通过。
- 测试调用的是 `Agent.prompt`，模型是 `fauxProvider` 的脚本回复。
- 工具结果来自进程内目录，字段 `source` 为 `simulated-local`。
- 已在 1.5.2 的安装包里确认 `gpt-4.1-mini` 这个 id 存在。没有发 completion 请求。

未验证：

- 任何真实 LLM 的工具选择或文案。
- 任何 Kubernetes、云 API 或生产告警。
- Holmes 未读到的插件是否在 `_invoke` 里面自己重试。
- `1.5.2` 之后的 Pi `main`。

依赖装好之后，`npm test` 不应再访问注册表或集群。faux 的默认 base URL 在源码里是 `http://localhost:0`，1.5.2 的 `faux.ts` `stream` 在进程内拼 assistant 消息，不发起集群请求。
