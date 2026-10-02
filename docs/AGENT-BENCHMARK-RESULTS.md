# 2026-10-02 Agent Benchmark 实测结果

**目标尚未全部完成：预算停止后两项未执行。** 已建立任务集→真实 Pi Agent→轨迹→确定性评分→报告闭环，单年度与三年正常研究均完成在线数据到文件交付。不得把本次结果称为六项全部运行或全通过。

结构化脱敏记录：[2026-10-02.json](../benchmarks/results/2026-10-02.json)。方法、命令与能力边界见 [Benchmark 方法](AGENT-BENCHMARK.md)。完整本地记录保留在 Git 忽略的 `data/agent-benchmark/first-round-2026-10-02/` 与 `data/agent-benchmark/first-round-repair-2026-10-02/`，各有最新 report.md、初始/版本化评分、冻结任务集、元数据、trace、独立 workspace 和预算。

## 当前逐任务状态

| ID                   | 模式             | 修复后请求 / 输出 token | 自动结构/交付结果                                        | 总状态         |
| -------------------- | ---------------- | ----------------------: | -------------------------------------------------------- | -------------- |
| annual-aapl          | live_sec         |                3 / 2094 | 五项数值、可比同比、引用与报告审计通过                   | needs_review   |
| trend-msft           | live_sec         |                3 / 2614 | 三年十五值、同比、图表与引用报告审计通过                 | needs_review   |
| missing-cash         | injected_failure |                4 / 2702 | 现金缺失、无现金证据、报告通过；一次 save 校验失败后修正 | needs_review   |
| incomparable-revenue | injected_failure |                 2 / 990 | 原始异币种与排除上期重算通过；回答输出截断，未生成报告   | failed         |
| sec-unavailable      | injected_failure |         0 / unavailable | 预算停止，未执行                                         | not_applicable |
| judgment-evidence    | snapshot         |         0 / unavailable | 预算停止，未执行                                         | not_applicable |

`needs_review` 表示确定性检查通过但自然语言仍需人工复核，不是全部通过。缺失任务最终回答同时说明明确注入移除现金标签，又在限制里写“无法确认缺失源于注入故障还是原始数据缺口”，存在需要人工检查的语义不一致；评分器没有用关键词替代语义核验。

修复后已执行四项、未执行两项；task_completion、tool_behavior、artifact_delivery 各 3 passed / 4 个适用项；numerical_correctness 为 4 / 4；evidence_integrity 为 3 / 4；failure_handling 为 1 passed、1 needs_review / 2；judgment_boundary 为 4 needs_review / 4。源失败与证据不足没有分母成绩。模式分别统计：live_sec 执行 2、未执行 0；injected_failure 执行 2、未执行 1；snapshot 执行 0、未执行 1。

## 原失败与修复记录

首次批次使用干净提交 `1e53cf7`：Apple 真实 SEC 获取成功，第二次模型请求错误，报告未交付；没有保留上游错误正文，无法进一步区分 Provider 与 Runtime 失败。Microsoft 三年报告和图表已生成且审计通过，但执行器误将 SVG 的 W3C XML 命名空间认作私有 URL，导致批次中断、最终轨迹未写完。后四项未执行，原数据未覆盖。

修复提交 `97f1455` 限定允许标准 SVG 命名空间，并增加原子脱敏检查点、数字 HTTP 状态、部分已知用量与离线恢复/预算续接。原 Microsoft 轨迹、最终回答、实际请求/用量丢失部分均标 unavailable，没有从文件反造工具调用。原三年已审计报告 SHA-256 为 `3711089f15c5bbe10aafe3f4c42a8900bb4e33c3699338b1409812a5584b277e`；产物存在不代表轨迹完整。

修复后批次也使用干净提交 `97f1455`。针对受执行记录修复影响的正常任务重跑，并首次运行后续异常任务；没有改变任务版本/评分规则或删除失败。20 项离线评分与边界测试通过；金融 75 项、前端 102 项、会话/ACL 48 项及必要构建/类型/文档/格式检查通过。首实现 [CI](https://github.com/yetuge/fintrace/actions/runs/37013251056) 和修复 [CI](https://github.com/yetuge/fintrace/actions/runs/37014241228) 都通过。

## 真实模型消耗与预算停止

修复批次实际 12 次请求、8400 输出 token、累计任务耗时 187489 毫秒。首次 Apple 两次请求已知，首次 Microsoft 请求次数丢失；不能报告完整实际总请求或完整输出用量。当前至少有 14 次可核验请求，另有丢失的三年任务，按每项最多四次保守预留。费用 unavailable，不估算。

首次两项完整输出用量都未知，按各自最多两次/四次请求、每次 1600 token 保守预留 9600。续跑使用 `--carry-from` 将这些预留计入同一上限，因此预算记账达到 **18 次请求额度、18000 输出 token 额度**（9600 预留 + 8400 可核验输出），实际总消耗 unavailable。预留不是实际用量、成本估计或“已输出 18000 token”。

不可比任务的第二次模型输出耗尽剩余 990 token，stopReason=length；这是预算导致的交付失败，不是 SEC 异币种规则失败。随后停止新增请求，两项 not_executed 保留为 N/A。没有为了取得成绩另开无预算批次。用户已明确追加授权：只运行尚未执行的限流与解释证据不足两项，最多新增六次请求、4800 输出 token；原预算停止与失败记录保留，不重跑其余任务。补充批次结果待执行后记录。

## 复现与局限

```bash
# 全部离线；不调用模型、SEC 或读取凭据
npm run test:benchmark
npm run benchmark -- score --batch=first-round-repair-2026-10-02
npm run benchmark -- score --batch=first-round-repair-2026-10-02 --task=missing-cash
npm run benchmark -- summarize --batch=first-round-repair-2026-10-02
```

真实数据目录只保留在本地，公开结果提供 trace/产物哈希和评分依据，Git 克隆不包含本机 data 或凭据。在线数据和模型输出会变化；不能承诺他日同条件完全相同。20 项离线测试可在干净 CI 重现，不代表真实任务全部通过。当前全仓实际测试 313 文件通过、31 失败，2926 项通过、46 失败、23 跳过；新增显现的一项 cancellation 失败在原 HEAD `ebbb602` 隔离检出也复现，详见 [验证记录](VERIFICATION.md)。

本批次从 CLI 调用工作台实际使用的 Pi Runtime 和金融工具，隔离工具范围与插件/记忆/上下文；没有经正常登录工作台发送本批模型问题。已有已登录 Electron 可连接，但工作台消息链路与本批结果未关联，因此不宣称 UI 端到端已验证。没有新截图、假模型、预写回复、LLM judge、正文读取或语义签署，也没有多 Agent/RAG/新源/交易功能。小样本仅描述此任务集，不推导普遍成功率或框架优越性。
