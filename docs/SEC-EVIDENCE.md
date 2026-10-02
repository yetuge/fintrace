# SEC 指标证据与报告契约

## 范围与版本

本轮只关联 SEC Company Facts 提取的年度指标，不抓取申报正文。期间、币种、缺失值、修订选择与同比仍由原有指标代码处理；测试数据不会作为产品回退。

每次 `fetch_sec_financials` 新建唯一研究目录。`raw.json` 保留官方响应；`metrics.json` 使用 `schemaVersion: 2`，包含原有指标、`datasetId`、代码构建的 `evidence` 与 `verifiedFacts`；`manifest.json` 记录版本、数据集标识及原始数据/指标哈希。`save_sec_report` 新增 `findings.json`（工具输入及规范化发现）与 Markdown 报告。重复相同保存可重试；不同内容拒绝覆盖。

证据 ID 为 `<datasetId>:<metricKey>:current|previous`。每项保留标签、指标名称、口径、金额、单位、实际期间、filed、accession、申报类型及 SEC 官方申报链接。模型不能新增证据。保存工具重新从落盘指标构建目录，并检查每个 ID 属于当前研究。

## 发现输入与分类

每条输入包含 `type`、`evidence_ids`、`limitations`；直接事实还须提供 `fact_id`，定性发现须提供 `content`。最终记录包含内容、类型、证据 ID、限制、原始请求类型及独立的核验状态。

| 类型                      | 当前工具处理                                                                  | 核验边界                                                         |
| ------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `direct_fact` 直接事实    | 必须选本数据集代码事实与完整证据集合，内容由代码生成，忽略模型自由文本        | 核验指标金额、可比同比方向及同期间变动率比较；不核验因果         |
| `interpretation` 分析解释 | 接受原始分类，但当前仅有指标，统一保守降为 `unverified`，保留 `requestedType` | 引用存在不能证明解释充分；不自动认可盈利质量、主营能力或偿债压力 |
| `unverified` 待验证判断   | 必须提供内容与具体缺失资料；无可用指标时允许空证据列表并明示缺口              | 未进行定性语义、正文或因果核验                                   |

定性发现不得自行填写数值；代码事实目录提供本期/上期数值、可比同比和同期间变动率比较，缺失与不可比时不生成对应事实。总负债不是有息债务，净利润与经营现金流变化不能单独证明盈利质量改善，现金余额也不能单独证明杠杆可控。模型应在限制中列出利润/现金流构成、非经常性损益、债务期限、利息覆盖等尚缺资料。

报告逐条展示类别、证据链接与限制，文件面板沿用现有 Markdown 预览。当前没有自动认可的定性解释，是本轮保守策略；原始分析解释与待验证分类可同时追溯，并不意味着模型已完成正文核验。

## 旧产物兼容与离线核验

版本一原始数据、指标与报告保持只读，不原地升级、补分类或覆写历史验证文件。保存工具拒绝向旧研究写入新报告，需重新获取生成新的版本二目录。

```bash
npx tsx scripts/verify-sec-artifacts.ts <research-directory>
# 可选：该次 Pi 会话日志目录，仅输出脱敏后的工具/调用数量
npx tsx scripts/verify-sec-artifacts.ts <research-directory> <Pi-session-directory>
```

脚本默认只输出核验摘要，不写文件、不联网、不读取模型配置。两种版本都检查原始/指标哈希，并从原始响应重算金额、期间、出处、同比及不可比原因。版本一允许历史指标说明文字与当前版本不同，但不放宽数值或来源检查；其定性发现明确标为未审计。版本二还严格重建全部指标、证据与事实目录、规范化分类，并逐字核对代码生成的报告。

`rawAndMetricsHashesValid`、`recomputedMetricsMatch`、`evidenceAssociationsVerified` 与 `qualitativeSemanticsVerified` 是不同含义；最后一项当前始终为 false。完整性和关联检查通过，不能升级为结论语义成立。

## 可复现 CI

```bash
npm ci
npm --prefix container/agent-runner ci
npm run test:financial
npm --prefix container/agent-runner run build
npm run build
# 现有前端检查
npm --prefix web ci
npm run test:frontend
npm run docs:check
npm run build:web
```

金融 CI 独立安装根目录与 Runner；前端 job 保留原有依赖、测试、文档与构建检查。金融测试覆盖提取、证据契约、Pi 工具落盘、离线重算、旧产物兼容以及现有工具初始化、插件挂载和 Provider Runtime 契约，不调用真实模型或 SEC，不需要本地 data、联系信息或密钥。CI 同时检查共享类型与 Prompt 引用。

小型合成 fixture 在 `tests/fixtures/sec-synthetic.ts`；版本一合成产物在 `tests/fixtures/sec-legacy-v1/`。所有金额与公司仅用于测试，不代表实际申报；期间、币种、重复、修订、缺失和不可比场景由测试在新副本上调整。真实 SEC 网络检查仍通过显式 `scripts/verify-sec-live.ts` 在有本地联系配置的环境运行，不纳入日常 CI；本轮没有新增需要个人邮箱的手动工作流。
