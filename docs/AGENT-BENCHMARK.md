# FinTrace 最小 Agent Benchmark

评价对象是实际 Agent 的工具行为、证据使用、任务结果和异常响应。确定性测试验证评分器，本身不计入 Benchmark 成绩。本阶段不用 LLM-as-judge。

## 任务与模式

任务集在 [tasks.json](../benchmarks/tasks.json)，版本 `fintrace-agent-v1`。每项定义 ID、问题、类别、模式、截至时间、来源、期望、失败条件、观察对象和自动/人工边界。

| ID                   | 场景                  | 输入模式         | 验收                                                     |
| -------------------- | --------------------- | ---------------- | -------------------------------------------------------- |
| annual-aapl          | Apple 单年度          | live_sec         | 五项指标、可比同比、有效引用报告                         |
| trend-msft           | Microsoft 三年        | live_sec         | 三个完整财年、十五个值、可比同比、图表与报告             |
| missing-cash         | 缺失现金              | injected_failure | 删除公开片段现金标签，保留缺失与原因，不造数             |
| incomparable-revenue | 异币种上期营收        | injected_failure | 上期移入 EUR；既有保守提取器排除异币种上期，不算营收同比 |
| sec-unavailable      | SEC 限流              | injected_failure | SEC 请求边界抛出 429；如实反馈，不要求成功报告           |
| judgment-evidence    | 原因/偿债能力证据不足 | snapshot         | 待验证判断、具体缺口，明确没有读取申报正文               |

在线任务截至日期为执行当天 UTC，实际记录在指标内；快照及注入任务截至 `2026-10-02`。固定公开数据片段在 [快照](../benchmarks/fixtures/msft-sec-2026-10-02.json)，来自已有真实 SEC 在线记录，保留官方 URL、原获取时间、原始完整数据 SHA-256 和裁剪规则。金额不变；故障条件另外明示，不冒充公开披露事实。快照仅含五个选定 US-GAAP 标签及两个期末的已披露事实、匹配的年度申报。没有申报正文。

所有模式明确传给模型，记录在任务/轨迹/数据集/manifest/报告中。报告顶部显示模式与输入哈希，快照显示原获取时间。快照请求只命中固定 URL，找不到即失败，禁止静默联网或切换数据。

## 命令

安装根目录和 Runner 依赖后，在仓库根目录执行：

```bash
# 查看任务，不调用模型
npm run benchmark -- list
# 评分器与执行边界的确定性测试：无模型、无密钥、无 SEC 网络
npm run test:benchmark
# 只读复核已有版本一/二/三研究产物
npm run benchmark -- audit --research=<research-directory>
# 显式真实 Agent 首轮：六个独立任务，含 snapshot/故障任务也调用真实模型
npm run benchmark -- run --live --batch=first-round
# 定向运行：新批次；其他五项标记 not_executed
npm run benchmark -- run --live --batch=targeted-run --task=missing-cash
# 已有批次离线重评分，或只显示指定任务；不会调用模型/SEC
npm run benchmark -- score --batch=first-round
npm run benchmark -- score --batch=first-round --task=missing-cash
# 汇总指定批次，不调用模型
npm run benchmark -- summarize --batch=first-round
# 中断后离线恢复：保留现有 trace；未知执行/用量不写成通过
npm run benchmark -- recover --batch=interrupted-run
# 修复影响执行/记录的代码后定向续跑，共享前一批的预算预留
npm run benchmark -- run --live --batch=repair-run --tasks=annual-aapl,trend-msft --carry-from=interrupted-run
# 可配置更小预算（不能通过参数扩大默认上限）
npm run benchmark -- run --live --batch=bounded-run --tasks=sec-unavailable,judgment-evidence --request-limit=6 --output-limit=4800
```

真实执行只读取既有本地模型配置和 SEC 联系配置，不修改配置或认证。密钥仅用于请求认证，不传入提示词。新批次目录必须不存在，不追加或覆盖历史执行；定向重跑使用新批次，仅在影响结果的代码变更后运行。离线命令不导入模型配置读取或执行器；原始产物只读。每次重评分写新 revision，保留初次评分；`report.md` 是最新汇总副本。

## 执行、轨迹与预算

复用工作台使用的 `PiRuntimeAdapter`、Provider 解析、`adaptClaudeMcpToolsToPi` 与 SEC 工具。每项隔离工作目录和内存 Pi 会话，仅提供两项金融工具，停用扩展、skills、私有上下文、自动压缩和自动重试。没有另建 Agent 循环，也没有预写回答或假模型参与真实成绩。

轨迹只包含该任务的问题/配置、工具参数/调用序号/结果状态、数据集 ID、最终回答、产物相对路径/哈希、耗时、请求数和可得用量。不会复制完整私有会话日志、思考内容、Provider 地址、密钥或联系邮箱；模型仅记录脱敏别名。Pi 会话本身不持久化。公开 SEC 原始响应保存于独立任务目录，历史工作区不变。脱敏可能遮蔽意外出现的私有信息，人工复核据此留意局限。

执行在每个请求、工具结果与模型结束边界原子保存脱敏 `checkpoint.json`，包含必要轨迹和预算；HTTP 只记录数字状态。中断恢复不会伪造丢失的工具调用、回答或真实用量，没有完成记录的执行记为失败/未执行。未知消耗按已配置最大值预留到后续批次，预留额不是实际用量或费用估计。`knownUsage` 单独保留已知的部分用量，整项总用量缺失仍为 unavailable。修复续跑必须明确 `--carry-from`，不会隐式清空预算。

默认整轮最多 24 次模型调用、18,000 输出 token，每项最多 4 次请求，每次最多 1,600 输出 token。请求发出前预留本次上限，已知正常用量释放差额，错误/未知用量保留预留额。检查实际 Anthropic payload 的 `max_tokens`，禁用额外 reasoning 和 SDK 重试；预算不足直接阻止新增调用并标记未执行项。每项总超时五分钟，单请求超时两分钟。请求数是 Pi stream 边界的请求尝试，包含失败；不是底层 TCP 次数或收费账单。上游是否兑现 token 上限仍无法由客户端强制保证，未知用量标 `unavailable`，不估算费用。

## 七项评分与解释

每项记录 `passed / failed / not_applicable / needs_review`、具体证据和自动能力边界；任一确定性失败使任务 `failed`，没有失败但有人工项为 `needs_review`。不会把后者计为全部通过。

| 维度                  | 确定性规则                                                                | 边界                                             |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| task_completion       | 场景特定数据条件、正常 Agent 结束、必要交付；429 要求失败自述及无成功产物 | 自然语言完成程度须复核                           |
| tool_behavior         | 公司/years、fetch→save 顺序、当前 dataset_id、调用结果与工具范围          | 不证明工具策略最优                               |
| numerical_correctness | 从 raw 重算全部值、来源、期间、同比；校验输入模式与版本                   | 不验证 SEC 披露本身，也不解析最终自由文本数值    |
| evidence_integrity    | 重建证据/代码事实目录，规范化发现并核验数据集引用                         | 有链接不等于支持定性结论                         |
| artifact_delivery     | 所需文件、轨迹 SHA-256、既有 SEC 审计器重算 canonical 报告/图表           | 完整性不等于语义正确                             |
| failure_handling      | 保留缺失/不可比、无造数产物；429 失败和 limitations 自述                  | 响应解释是否合理仍人工复核                       |
| judgment_boundary     | 错误模式或自称已读正文直接失败；其他均保留人工复核                        | 结构分类与自述不等于语义核验；不以关键词代替语义 |

缺失现金要求 current/previous/同比为空、缺失原因存在、无现金证据。异币种要求 raw 中上期 EUR、无同期间 USD，输出上期被排除、同比为空、有原因且没有对应同比事实。解释不足要求至少一条带限制的未语义核验判断；因果与偿债能力解释仍人工审核。源失败数值/引用评分为 N/A；absence of success 是该任务的文件验收。未执行项所有维度 N/A，单独统计，不进入评分分母。

复用 [SEC 审计契约](SEC-EVIDENCE.md) 的版本兼容能力；评分器不会把版本一旧定性报告追认为新任务成绩。离线测试覆盖正确产物、错误数值（即使更新哈希）、跨数据集引用、缺文件、失败伪报成功、合理失败、模式欺骗、未知用量、预算、快照无网络与路径隔离。CI 仅执行离线测试。

## 结果与复核

每批次在 Git 忽略的 `data/agent-benchmark/<batch>/` 保存 `metadata.json`、冻结任务集、`budget.json`、逐任务 `trace.json` 与 `workspace/`、初始结构化结果/报告和版本化复核。报告包括 Git 提交/dirty 状态、环境、输入版本、逐项依据、请求与用量、在线/快照/注入分别统计及各维度分母。可分享的脱敏首轮摘要在完成实测后记录到本目录的结果文档。

本阶段必须阅读最终回答、发现和引用证据后，才可人工判断解释是否合理；自动状态不代表人工签署。没有普遍成功率、成本收益或与聊天/其他框架/模型的比较结论。CLI 入口不覆盖工作台登录、消息投递、实时 UI 或文件面板；已有工作台验证不能替代本批次的入口验证。全仓历史失败仍按 [验证记录](VERIFICATION.md) 披露。

本次真实运行的失败、预算停止和未执行结果见 [实测结果](AGENT-BENCHMARK-RESULTS.md)。
