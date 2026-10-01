/** SEC Company Facts values are already in base units; never multiply by a scale. */
export interface Fact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  filed: string;
  form: string;
  fy?: number;
  fp?: string;
}
export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, Fact[]> }>>;
}
export interface Filing {
  accession: string;
  form: string;
  filed: string;
  end: string;
  document: string;
  url: string;
}
const annualForms = new Set([
  '10-K',
  '10-K/A',
  '20-F',
  '20-F/A',
  '40-F',
  '40-F/A',
]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: string): boolean {
  const time = Date.parse(value);
  return (
    datePattern.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  );
}
export function days(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
}
export function filingsFromColumns(
  columns: Record<string, unknown>,
  cik: string,
): Filing[] {
  const values = (key: string): string[] =>
    Array.isArray(columns[key]) ? (columns[key] as string[]) : [];
  return values('accessionNumber').flatMap((accession, i) => {
    const form = values('form')[i];
    const filed = values('filingDate')[i];
    const end = values('reportDate')[i];
    const document = values('primaryDocument')[i];
    if (
      !annualForms.has(form) ||
      !validDate(end ?? '') ||
      !validDate(filed ?? '') ||
      !/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
      !document ||
      /[\\/]|\.\./.test(document)
    )
      return [];
    return [
      {
        accession,
        form,
        filed,
        end,
        document,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${encodeURIComponent(document)}`,
      },
    ];
  });
}
export const metricDefinitions = [
  {
    key: 'revenue',
    label: '营收',
    duration: true,
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
    ],
    basis: '合并年度营业收入，优先不含代收税的客户合同收入',
  },
  {
    key: 'netIncome',
    label: '净利润',
    duration: true,
    tags: ['NetIncomeLoss', 'ProfitLoss'],
    basis:
      '年度净利润/亏损，非每股收益；NetIncomeLoss 为归属于母公司，ProfitLoss 包含非控股权益，标签不同不混算',
  },
  {
    key: 'operatingCashFlow',
    label: '经营现金流',
    duration: true,
    tags: ['NetCashProvidedByUsedInOperatingActivities'],
    basis: '年度经营活动净现金流',
  },
  {
    key: 'cash',
    label: '现金',
    duration: false,
    tags: ['CashAndCashEquivalentsAtCarryingValue'],
    basis: '财年末现金及现金等价物，不含短期投资及受限现金',
  },
  {
    key: 'liabilities',
    label: '总负债',
    duration: false,
    tags: ['Liabilities'],
    basis: '财年末全部负债，包括流动与非流动负债，非仅有息债务',
  },
] as const;
export interface SelectedValue {
  value: number;
  unit: string;
  tag: string;
  start?: string;
  end: string;
  accession: string;
  filed: string;
  form: string;
  source: string;
}
export interface Metric {
  key: string;
  label: string;
  basis: string;
  current: SelectedValue | null;
  previous: SelectedValue | null;
  yoyPercent: number | null;
  missingReason: string | null;
  yoyReason: string | null;
}
export function calculateYoy(
  current: SelectedValue | null,
  previous: SelectedValue | null,
): { percent: number | null; reason: string | null } {
  if (!current || !previous)
    return { percent: null, reason: '缺少本期或可比上期数据' };
  if (current.unit !== previous.unit || current.tag !== previous.tag)
    return { percent: null, reason: '币种或指标标签不一致' };
  const gap = days(previous.end, current.end) - 1;
  if (
    gap < 330 ||
    gap > 400 ||
    Boolean(current.start) !== Boolean(previous.start)
  )
    return { percent: null, reason: '不是可比的相邻年度期间' };
  if (
    current.start &&
    previous.start &&
    Math.abs(
      days(current.start, current.end) - days(previous.start, previous.end),
    ) > 8
  )
    return { percent: null, reason: '年度期间长度不可比' };
  if (previous.value <= 0)
    return { percent: null, reason: '上期为零或负数，不计算常规增长率' };
  const percent = ((current.value - previous.value) / previous.value) * 100;
  return Number.isFinite(percent)
    ? { percent, reason: null }
    : { percent: null, reason: '计算结果超出数值范围' };
}
export interface FinancialDataset {
  schemaVersion: 1;
  company: { cik: string; name: string; tickers: string[] };
  fetchedAt: string;
  asOf: string;
  latestAnnual: Filing;
  previousAnnualEnd: string | null;
  annualStart: string | null;
  currency: string | null;
  metrics: Metric[];
  sources: string[];
  warnings: string[];
}
export function extractFinancials(
  facts: CompanyFacts,
  filings: Filing[],
  tickers: string[],
  fetchedAt: string,
  asOf: string,
  sources: string[],
): FinancialDataset {
  const eligible = filings.filter((f) => f.filed <= asOf && f.end <= asOf);
  const latestAnnual = [...eligible].sort(
    (a, b) =>
      b.end.localeCompare(a.end) ||
      b.filed.localeCompare(a.filed) ||
      b.accession.localeCompare(a.accession),
  )[0];
  if (!latestAnnual)
    throw new Error('SEC_NO_ANNUAL: 未找到截至日期内的年度申报');
  const previousAnnualEnd =
    [...new Set(eligible.map((f) => f.end))]
      .filter(
        (end) =>
          days(end, latestAnnual.end) - 1 >= 330 &&
          days(end, latestAnnual.end) - 1 <= 400,
      )
      .sort()
      .at(-1) ?? null;
  const filingMap = new Map(eligible.map((f) => [f.accession, f]));
  const gaap = facts.facts?.['us-gaap'] ?? {};
  function candidates(
    tag: string,
    end: string,
    duration: boolean,
    unit?: string,
    start?: string,
  ): SelectedValue[] {
    return Object.entries(gaap[tag]?.units ?? {}).flatMap(
      ([currency, entries]) => {
        if (!/^[A-Z]{3}$/.test(currency) || (unit && unit !== currency))
          return [];
        return entries.flatMap((f) => {
          const filing = filingMap.get(f.accn);
          if (
            !filing ||
            f.form !== filing.form ||
            f.filed !== filing.filed ||
            f.end !== end ||
            f.filed > asOf ||
            !Number.isFinite(f.val) ||
            Math.abs(f.val) > Number.MAX_SAFE_INTEGER
          )
            return [];
          if (
            duration
              ? !f.start ||
                !validDate(f.start) ||
                days(f.start, f.end) < 330 ||
                days(f.start, f.end) > 400 ||
                (start && f.start !== start)
              : Boolean(f.start)
          )
            return [];
          return [
            {
              value: f.val,
              unit: currency,
              tag: `us-gaap:${tag}`,
              ...(f.start ? { start: f.start } : {}),
              end: f.end,
              accession: f.accn,
              filed: f.filed,
              form: f.form,
              source: filing.url,
            },
          ];
        });
      },
    );
  }
  function choose(rows: SelectedValue[]): {
    value: SelectedValue | null;
    reason: string | null;
  } {
    if (!rows.length)
      return {
        value: null,
        reason: '没有满足年度期间、币种及申报来源约束的标准事实',
      };
    const latestFiled = rows
      .map((f) => f.filed)
      .sort()
      .at(-1)!;
    const latest = rows.filter((f) => f.filed === latestFiled);
    const signatures = new Set(
      latest.map((f) =>
        JSON.stringify([f.value, f.unit, f.start ?? null, f.end]),
      ),
    );
    if (signatures.size !== 1)
      return {
        value: null,
        reason: '最新申报存在多币种、不同期间或冲突值，需人工核验',
      };
    return {
      value: latest.sort((a, b) => b.accession.localeCompare(a.accession))[0],
      reason: null,
    };
  }
  let annualStart: string | null = null;
  let currency: string | null = null;
  for (const definition of metricDefinitions.filter((d) => d.duration)) {
    for (const tag of definition.tags) {
      const picked = choose(candidates(tag, latestAnnual.end, true));
      if (picked.value) {
        annualStart = picked.value.start!;
        currency = picked.value.unit;
        break;
      }
    }
    if (annualStart) break;
  }
  const metrics: Metric[] = metricDefinitions.map((definition) => {
    let current: SelectedValue | null = null;
    let missingReason: string | null = '未提供受支持的 US-GAAP 标准标签';
    let chosenTag: string | null = null;
    for (const tag of definition.tags) {
      const rows = candidates(
        tag,
        latestAnnual.end,
        definition.duration,
        currency ?? undefined,
        definition.duration ? (annualStart ?? undefined) : undefined,
      );
      if (!rows.length) continue;
      const picked = choose(rows);
      current = picked.value;
      missingReason = picked.reason;
      chosenTag = tag;
      break;
    }
    const previous =
      current && chosenTag && previousAnnualEnd
        ? choose(
            candidates(
              chosenTag,
              previousAnnualEnd,
              definition.duration,
              current.unit,
            ),
          ).value
        : null;
    const yoy = calculateYoy(current, previous);
    return {
      key: definition.key,
      label: definition.label,
      basis: definition.basis,
      current,
      previous,
      yoyPercent: yoy.percent,
      missingReason,
      yoyReason: yoy.reason,
    };
  });
  return {
    schemaVersion: 1,
    company: {
      cik: String(facts.cik).padStart(10, '0'),
      name: facts.entityName,
      tickers,
    },
    fetchedAt,
    asOf,
    latestAnnual,
    previousAnnualEnd,
    annualStart,
    currency,
    metrics,
    sources,
    warnings: [
      '只提取 Company Facts 的公司整体标准 US-GAAP 标签；不推算缺失值，不使用自定义标签、季度累计值或行情数据。',
      '优先采用截至日期内最近年度申报披露的同期间数值；修订仅对实际披露的事实生效，保留每个值的 accession。',
      '总负债指全部会计负债，现金不含短期投资；不同标签、币种或不可比期间不计算同比。',
      ...(days(latestAnnual.end, asOf) > 550
        ? ['最新年度申报已较陈旧，请核查公司申报状态。']
        : []),
    ],
  };
}
