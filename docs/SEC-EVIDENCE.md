# SEC 指标证据与报告契约

## 版本三：最近三个完整财年

`fetch_sec_financials({ company, years: 3 })` 新建独立版本三目录；省略 `years` 或传 `1` 继续生成版本二，不改变旧单年度提取及报告。版本一、二既有文件保留原样，离线核验支持三个版本；不原地迁移或追认旧定性结论。

版本三包含 `years`（实际起止及年度申报）、五项指标各自的 `annual` 序列、逐年度 `evidence`、`verifiedFacts`、`excludedPeriods`、警告及 `restatementPolicy: latest_disclosed_as_of`。证据 ID 为 `<datasetId>:<metricKey>:<实际期末>`，值事实、相邻变化与连续链事实各自有独立 ID。证据保留标签、口径、币种、基础单位、数值、实际日期、filed、accession、申报类型及官方来源。

年度识别同时要求官方年度申报与真实完整流量期间：360–380 天，覆盖正常 365/366 天与五十二/五十三周，不从 fy/fp/frame 或日历年份推导。多个期间冲突、短过渡期及异常财年变更保守排除并记录；余额按已确认完整年度期末取得。最近三个可靠完整年度可能不连续；缺失年度不能产生跨缺口同比或连续趋势。无可靠年度也可保存明确说明缺口的报告，不补季度或模型数值。

历史值统一选择截至研究日期内最新年度披露的同期间事实，包括修订及后续年度的比较数，不采用原始披露序列。每个值仍保留自己的来源；不同指标可能在不同申报中最后披露，这不代表所有指标已一起重述。修订只改变实际披露的指标，同一最近披露存在不同币种或冲突值时缺失，不回退旧值。选标签按最新披露时间优先，同日使用明确标准标签优先级；标签不同不当作相同口径混算。Company Facts 单位为基础金额，不推测倍数。

相邻变化要求标签/币种相同、完整年度连续、期末间隔及期间长度可比。金额方向由代码比较，可包括负数；常规同比还要求上年大于零。最早展示年度不强求同比。连续增加、减少或持平仅在三个指标值完整且各相邻期间均兼容时生成；这些是金额方向，不是经营原因、盈利质量或偿债能力的验证。模型只能选当前代码事实和完整证据集合；定性解释沿用保守降为待验证判断的策略。

`chart-data.json` 的点、基础值、缩放值、币种、证据 ID、缺失原因与连接状态均由结构化指标生成。`trends.svg` 为确定性渲染；每个指标/币种独立坐标轴，明确百万/十亿单位，包含零轴并保留负数，缺失不补零、不插值，跨标签/币种/期间不连线。现有文件面板直接预览 SVG 与 Markdown，无新研究页面。

版本三目录包含 `raw.json`、`metrics.json`、`manifest.json`、`chart-data.json`、`trends.svg`、`findings.json` 与 `report.md`。manifest 保存原始/指标/图表哈希、可用年度、缺失值和排除期间。获取或图表写入失败直接报错，不返回完成；报告只在全部所需输出写入后返回 `saved: true`。相同内容可重试，不同内容拒绝覆盖。保存前从原始快照重建指标和代码事实并校验图表。

版本三每条发现最多关联十五个年度值，版本二仍为十项。文件面板将 SVG 附件作为经过静态基本绘图检查的图片预览，不插入活动 HTML，不开放后端任意 SVG MIME；脚本、事件、外部引用、样式和 HTML 嵌入被拒绝，加载失败明确提示。截图与真实验证见验证记录。

离线核验重新从 raw 提取完整年度、值、出处、同比、趋势事实及证据，重建图表全部点和 SVG，检查 manifest 完整性摘要、发现分类及逐字报告。`chartDataAndRenderingVerified` 表示数据/绘图重算通过，仍不代表定性语义或因果核验。网络、图表生成失败不能自动改用模拟数据。

```bash
npx tsx scripts/verify-sec-live.ts --years=3
npx tsx scripts/verify-sec-artifacts.ts <research-directory>
```

日常 CI 的 `tests/sec-trends.test.ts` 使用小型合成 fixture，覆盖三年实际期间、重述及修订、重复/冲突、单位币种、五十二/五十三周、过渡期、缺失年、标签变化、负利润、不可比同比、连续链、图表缩放与断点、Pi 落盘、伪造引用及报告/图表篡改；不联网、不调用模型、不依赖本机配置。真实网络及工作台模型运行记录见 [验证记录](VERIFICATION.md)。

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
