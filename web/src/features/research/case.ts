export const sources = [
  {
    id: 'S1',
    title: 'Microsoft Annual Report 2024',
    publisher: 'Microsoft Investor Relations',
    type: '年度财报',
    location: 'Income Statements · Year Ended June 30',
    url: 'https://www.microsoft.com/investor/reports/ar24/',
    description: '核对公司全年收入、财年截止日及金额单位。',
  },
  {
    id: 'S2',
    title: 'FY24 Q4 Earnings Release',
    publisher: 'Microsoft Investor Relations',
    type: '业绩公告',
    location: 'Annual Results · Constant Currency Reconciliation',
    url: 'https://www.microsoft.com/en-us/investor/earnings/fy-2024-q4/press-release-webcast',
    description: '区分全年与第四财季、已报告与固定汇率增速。',
  },
  {
    id: 'S3',
    title: 'Segment Revenue (Detail)',
    publisher: 'SEC EDGAR · Microsoft filing',
    type: 'XBRL 披露',
    location: '12 Months Ended · Original FY2024 segments',
    url: 'https://www.sec.gov/Archives/edgar/data/789019/000095017024087843/R115.htm',
    description: '交叉核对原始披露分部口径下的收入与增量。',
  },
] as const;

export const financials = {
  current: 245122,
  previous: 211915,
  cloudCurrent: 105362,
  cloudPrevious: 87907,
  quarterCurrent: 64727,
  quarterPrevious: 56189,
};
export const growth = (current: number, previous: number) =>
  ((current - previous) / previous) * 100;
export const annualGrowth = growth(financials.current, financials.previous);
export const cloudShare =
  ((financials.cloudCurrent - financials.cloudPrevious) /
    (financials.current - financials.previous)) *
  100;

export interface Claim {
  id: string;
  title: string;
  kind: 'fact' | 'derived' | 'scope' | 'open';
  label: string;
  summary: string;
  formula?: string;
  sourceIds: string[];
  scope: string;
}

export const claims: Claim[] = [
  {
    id: 'C1',
    title: '全年收入同比增长 15.67%',
    kind: 'fact',
    label: '事实核对',
    summary:
      'FY2024 收入为 245,122 百万美元，FY2023 为 211,915 百万美元。采用截至各年 6 月 30 日的十二个月数据。',
    formula: '(245,122 − 211,915) ÷ 211,915 × 100% = 15.67%',
    sourceIds: ['S1', 'S3'],
    scope: 'Microsoft · 全年 · USD million · 已报告口径',
  },
  {
    id: 'C2',
    title: 'Intelligent Cloud 占收入增量的 52.56%',
    kind: 'derived',
    label: '计算推导',
    summary:
      '该分部收入增加 17,455 百万美元，公司总收入增加 33,207 百万美元。支持其为主要增量来源之一的判断。',
    formula: '(105,362 − 87,907) ÷ (245,122 − 211,915) × 100% = 52.56%',
    sourceIds: ['S3'],
    scope: '采用 FY2024 原始分部披露；此比例不是 AI 收入贡献',
  },
  {
    id: 'C3',
    title: '16% 与 15% 对应不同期间或汇率口径',
    kind: 'scope',
    label: '口径已解释',
    summary:
      '全年已报告增速约 16%，第四财季已报告增速约 15%，全年固定汇率增速也约 15%。仅凭百分比无法判断冲突。',
    formula: '(64,727 − 56,189) ÷ 56,189 × 100% = 15.20%（第四财季）',
    sourceIds: ['S2'],
    scope: '同时核对期间、指标、汇率基础与报告版本',
  },
  {
    id: 'C4',
    title: '增长是否主要由 AI 带来？',
    kind: 'open',
    label: '待补充证据',
    summary:
      '分部收入增量不能直接归因为 AI。当前选取的披露表格无法量化 AI 对公司总收入增量的贡献，需要更细披露。',
    sourceIds: [],
    scope: '保留为待验证判断，不写入已确认结论',
  },
];

export const stages = [
  {
    title: '界定研究范围',
    action: '固定公司、期间与指标',
    detail:
      'Microsoft；FY2024 vs FY2023；revenue；USD million；reported。分部采用该次原始披露。',
    output: '研究范围与指标口径',
  },
  {
    title: '收集一手来源',
    action: '年报、业绩公告与 XBRL',
    detail:
      '三份公开披露构成本案例资料集。它们来自同一家公司，交叉核对不等于独立观点验证。真实 Adapter 拉取仍待接入。',
    output: 'S1 / S2 / S3 来源清单',
  },
  {
    title: '核对期间与口径',
    action: '解释 16% 与 15% 的差异',
    detail:
      '将十二个月与三个月、已报告与固定汇率分开。缺少表头时应补证，不按百分比文本直接判定冲突。',
    output: 'C3 口径差异说明',
  },
  {
    title: '计算并关联证据',
    action: '从原始数值复算增长',
    detail:
      '浏览器使用确定性公式计算年度增速与分部增量占比。每个结论保留输入、公式和来源定位。',
    output: 'C1 / C2 计算依据',
  },
  {
    title: '保留证据缺口',
    action: '限定 AI 因果解释',
    detail:
      '52.56% 是分部增量占比，不能写成 AI 贡献。保留 C4，待更细披露或人工复核。',
    output: 'C4 待确认项',
  },
  {
    title: '形成研究草稿',
    action: '输出可追溯的 Markdown',
    detail:
      '将事实、计算推导、口径说明和待确认项分开输出。演示中的复核标记仅保存在本次页面状态。',
    output: '带引用的研究草稿',
  },
];

export function buildReport(reviewed = false): string {
  return `# FinTrace · Microsoft FY2024 收入核对\n\n公开财报演示案例；不是 Agent 实际执行记录。\n复核状态：${reviewed ? '本次演示中已标记复核（未持久化）' : '待人工复核'}\n\n## 范围\n\nFY2024 vs FY2023，截至各年 6 月 30 日的十二个月；金额为百万美元；已报告口径；采用 FY2024 原始分部披露。\n\n${claims
    .map(
      (c) =>
        `## ${c.id} · ${c.title}\n\n分类：${c.label}\n\n${c.summary}\n\n${c.formula ? `计算：${c.formula}\n\n` : ''}口径：${c.scope}\n\n${
          c.sourceIds
            .map((id) => {
              const s = sources.find((s) => s.id === id)!;
              return `[${s.id} · ${s.title}](${s.url}) — ${s.location}`;
            })
            .join('\n\n') || '来源不足，保留待确认。'
        }`,
    )
    .join(
      '\n\n',
    )}\n\n## 来源与边界\n\n整理日期：2026-09-30。三份来源属于同一公司的公开披露，不代表三个独立判断。页面未执行实时抓取、模型调用或 Memory 写入。\n`;
}
