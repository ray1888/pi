# HolmesGPT 公开源码没有可移植的子 agent

核对对象是 [HolmesGPT/holmesgpt](https://github.com/HolmesGPT/holmesgpt) 的公开树，commit [`927b4aaad0a555ba118d3afe15ce264b3b131e41`](https://github.com/HolmesGPT/holmesgpt/commit/927b4aaad0a555ba118d3afe15ce264b3b131e41)（`chore(deps): bump litellm to 1.103.10`，2026-11-17 00:53:42 UTC）。克隆后 `HEAD` 与这个 commit 相同，`git rev-list --left-right --count 927b4aaa...HEAD` 为 `0 0`。结论只覆盖这一份公开树，不覆盖私有的 Robusta relay。

这一版没有“父 agent 循环调用工具后，另起一个有自己消息、工具名单和停止条件的子 agent 循环，再把子循环结果填回父工具结果”的实现。本目录因此只有这份来源说明。没有运行时代码，没有脚本模型，也没有 `package.json`。下面不把自加的安全限制写成 Holmes 的原行为，因为没有对应机制可移植。

## 用的定义

独立子 agent 需要同时满足：

1. 父循环已经在跑，并且父模型或父 harness 按明确条件发起一次委派。
2. 被委派的一方自己再进入 agent 循环：自己的消息、自己可见的工具、自己的轮次，直到自己的停止条件。
3. 子循环的可观察结果回到父循环的某一次 tool result，父循环还能继续。

只做下面任何一件事都不是子 agent：同一次循环里并行执行多个工具；工具函数直接返回数据；另一次没有工具的 LLM completion；由调度器新开一次顶层调查。

## 检索范围

在该 commit 的工作树上检索并阅读，而不是只看关键词是否出现：

- `holmes/**/*.py` 里全部 `.completion(` 调用。除 `holmes/core/llm.py` 的封装，以及 `tracing.py` 里同名包装方法外，真正发起 completion 的是四个文件：`tool_calling_llm.py` 的主循环、`llm_summarize.py`、`compaction.py`（同一摘要流程里可多次调用）、`checks.py` 的结构化收尾。
- 全部 `ToolCallingLLM(` 构造点。运行路径上是 `Config` 创建一次调查器，以及 `ToolCallingLLM.with_executor` 为同一次请求换工具执行器。`examples/custom_llm.py` 也只构造一个顶层实例。测试里的构造同样是单循环。
- `class *Tool`、`TodoWrite`、`fetch_skill`、`core_investigation`、`multi_agent`、`expose_remotely`、`ToolCallWorker`。
- `docs/` 里写着 multi-agent、delegate、spawn 的页面。
- `experimental/ag-ui/` 和仓库根的 `AGENTS.md`。

`AGENTS.md` 第一段写的是给在这个仓库里改代码的编码助手看的说明，不是 Holmes 运行时的子 agent。

## 唯一的 agent 循环

[`ToolCallingLLM`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tool_calling_llm.py#L305) 持有一个 `ToolExecutor`、一个 `LLM` 和 `max_steps`。默认 `max_steps = 100`，见 [`Config`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/config.py#L113)。

流式循环在 [`_call_stream`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tool_calling_llm.py#L1238)，`while` 从 [第 1299 行](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tool_calling_llm.py#L1299) 开始：

- 谁发起工具调用：当次 completion 返回的 `tool_calls`。没有单独的 harness 条件去创建另一个 agent。
- 工具从已启用的 toolset 来。`_get_tools()` 把它们交给同一次 completion。
- 同一轮的多个 tool call 用最多 16 个线程并行执行，见 [第 1551 行](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tool_calling_llm.py#L1551)。每个 future 调的是 `_invoke_llm_tool_call`，不是新的 `ToolCallingLLM`。
- 结果追加进同一份 `messages`，循环继续。
- 停止：模型不再返回 tool call，则发出 `ANSWER_END`；`i == max_steps` 时把 `tools` 置为 `None`，让这一轮不能再调工具；`cancel_event` 已置位则抛 `LLMInterruptedError`。错误和 Robusta refusal 直接抛出。

`with_executor` 只复制这个对象并换上另一个 `ToolExecutor`，注释写明是为了给同一次请求注入前端工具，不改变共享实例。见 [第 322 行](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/tool_calling_llm.py#L322)。

父子轨迹：没有 child id。一次调查只有这一条循环。

## 最接近、但不是子 agent 的实现

| 公开符号 | 触发 | 为何不是子 agent |
|---|---|---|
| `ToolCallWorker` | 另一集群的 Holmes 经 Robusta platform-mcp 写入 `RemoteToolCalls` 行；本进程认领后执行 | 模块文档写明每个行只跑一个工具，没有 LLM 循环。见 [`tool_call_worker.py` 开头](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/conversations_worker/tool_call_worker.py#L1)。`_get_llm` 只给工具内部数 token，见 [第 656 行](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/conversations_worker/tool_call_worker.py#L656) |
| 文档里的 multi-agent investigations | 账号开关 `multi_agent_investigation_enabled`，默认关；toolset 另有 `expose_remotely` | [cross-cluster-tools.md](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/docs/data-sources/cross-cluster-tools.md#L5) 描述的是调用方在同一次调查里执行另一集群上的工具。执行侧就是上面的 `ToolCallWorker`。`core_investigation`、`skills`、`robusta_platform_mcp` 文档写明永不远程暴露 |
| `TodoWriteTool` / `CoreInvestigationToolset` | 工具对象随 Python toolset 默认加载，`enabled=True`，且 `_is_core = True`。提示词 `todowrite_instructions` 与 `todowrite_reminder` 默认关闭，要 `--extended-planning`、`--enable-todos` 或 `todowrite_overrides(True)` 才写入系统提示 | [`_invoke`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/plugins/toolsets/investigator/core_investigation.py#L100) 只解析任务列表并返回一段文本。任务不会各自启动循环。提示词开关在 [`prompt.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/prompt.py#L32) |
| `SkillsFetcher.fetch_skill` | 模型调用该工具并传入 `skill_id` | 读技能正文，包在 `<skill>` 里返回给当前会话。见 [`skills_fetcher.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/plugins/toolsets/skills/skills_fetcher.py#L64) |
| `LLMSummarizeTransformer` | 配置了 fast model，且工具输出长度大于 `input_threshold`（默认 1000）。模块写明遗留且默认不推荐 | 一次没有 tools 的 completion。失败由调用方退回原文。见 [`llm_summarize.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/transformers/llm_summarize.py#L100) |
| `compact_conversation_history` | 当前消息放不进上下文窗口时，由同一个循环在下一次 completion 之前调用 | 一次或分块的摘要 completion。可以附上原 tools 以满足网关对 tool block 的要求；模型若仍发起 tool call，就改走不带工具的文本摘要。见 [`compaction.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/truncation/compaction.py#L379) |
| `_execute_ai_check` / `_execute_ai_check_two_phase` | 一次健康检查。Gemini 因不能同时带 tools 和 `response_format` 才分两段 | 第一段就是这次检查自己的 `ToolCallingLLM.call`。第二段是 `tools=None` 的结构化 completion，把已有结论收成 `{rationale, passed}`。见 [`checks.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/checks/checks.py#L76) |
| `TriggeredHealthCheck` 文档中的 spawn | Deployment rollout 后，operator 创建一个 `HealthCheck` | 新的顶层检查，不是正在运行的父循环里的子循环。见 [triggered-health-checks.md](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/docs/operator/triggered-health-checks.md#L9) |
| `ScheduledPromptsExecutor` | Supabase 里有到期的 scheduled prompt，且 DAL 已启用 | 轮询后调用顶层 chat 函数。见 [`executor.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/core/scheduled_prompts/executor.py#L38) |
| `_RoutingTool` | 多实例 toolset 的包装工具收到 `instance` | 去掉该参数后调用同名子工具的 `invoke`。子工具不是 agent。见 [`multi_instance.py`](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/holmes/plugins/toolsets/multi_instance.py#L119) |
| `experimental/ag-ui` | HTTP 客户端走 `/api/agui/chat` | 把同一次 Holmes 对话编成 AG-UI 事件。前端的 `HttpAgent` 是协议客户端。见 [experimental/ag-ui/README.md](https://github.com/HolmesGPT/holmesgpt/blob/927b4aaad0a555ba118d3afe15ce264b3b131e41/experimental/ag-ui/README.md#L1) |

`PplQueryAssistTool` 只把模型已经写好的 PPL 字符串包进结果，自己不调用模型。

## 没有父子调用轨迹

不存在 parent id、child id、委派工具和子工具白名单。可观察的轨迹是一条 `ToolCallingLLM` 循环：模型消息、若干并行工具结果、再回到同一消息列表。远程工具的执行侧轨迹是 `RemoteToolCalls` 行的认领和单次工具结果，文档写明不含 LLM 循环。

## 尚缺的信息

`ToolCallWorker` 的模块文档指向 relay 仓库里的 `docs/design/2026-06-10_remote-tool-execution.md`。该文件不在这份公开树里。账号开关 `multi_agent_investigation_enabled` 的服务端实现也不在这里。因此不能根据这份公开源码判断私有 relay 是否在调用方另起了 agent 循环。公开执行侧已经写明没有 LLM 循环。

没有运行 Holmes 的测试、Poetry 环境或真实模型。结论来自阅读上述 commit 的源码和文档。

`@earendil-works/pi-agent-core@1.5.2` 有 `Agent` 和作为工具接口的 `AgentTool`。那是 pi 自己的能力。Holmes 这一版没有对应的委派机制，所以这里没有用它们做 demo，也没有把“pi 可以在工具里再 new 一个 Agent”写成 Holmes 的行为。

## 未实现

- 没有子 agent demo，没有模拟目录，没有 JSONL trace。
- 没有 `npm ci`、`npm test` 或 `tsc`。本目录没有包。
- 没有连接集群，没有 shell 工具，没有密钥。
- 若要做一套 pi 自己的子 agent demo，需要另一次明确授权。那将是新设计，不是 Holmes 的 1:1。

HolmesGPT 公开仓库是 Apache-2.0。本文只记录路径、符号和机制，不复制其实现。

## 和已有两个 PR 的差别

[PR 1](https://github.com/ray1888/pi/pull/1) 与 [PR 2](https://github.com/ray1888/pi/pull/2) 在 `demos/ops-agent/` 放同一份只读模拟运维 demo，差别只是 `ORDER_FENCE`。它们不依赖 Holmes。本 PR 从 fork `main` `5f89cc0a7df669813650bfdac498f8ff865e8233` 长出，只新增本目录，不修改那两个分支，也不把它们当作 base。
