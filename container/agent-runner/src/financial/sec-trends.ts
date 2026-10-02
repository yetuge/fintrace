/** Three complete fiscal years. No calendar/frame/fy inference, quarterly stitching or model values. */
import {
  calculateYoy,
  days,
  metricDefinitions,
  type CompanyFacts,
  type Filing,
  type SelectedValue,
} from './sec-metrics.js';
import type { VerifiedFact } from './sec-evidence.js';

export interface AnnualPeriod {
  start: string;
  end: string;
  filing: Filing;
}
export interface AnnualPoint {
  end: string;
  value: SelectedValue | null;
  missingReason: string | null;
  yoyPercent: number | null;
  yoyReason: string | null;
}
export interface TrendMetric {
  key: string;
  label: string;
  basis: string;
  annual: AnnualPoint[];
}
export interface AnnualEvidence extends SelectedValue {
  id: string;
  metricKey: string;
  label: string;
  basis: string;
  period: string;
  currency: string;
}
export interface TrendDataset {
  schemaVersion: 3;
  datasetId: string;
  company: { cik: string; name: string; tickers: string[] };
  fetchedAt: string;
  asOf: string;
  requestedYears: 3;
  restatementPolicy: 'latest_disclosed_as_of';
  years: AnnualPeriod[];
  excludedPeriods: { end: string; reason: string }[];
  metrics: TrendMetric[];
  evidence: AnnualEvidence[];
  verifiedFacts: VerifiedFact[];
  sources: string[];
  warnings: string[];
}
const validDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const fullYear = (s: string, e: string) =>
  validDate(s) && validDate(e) && days(s, e) >= 360 && days(s, e) <= 380;
const annualForm = (s: string) => /^(10-K|20-F|40-F)(\/A)?$/.test(s);

/** Separate amount direction from growth rate: a loss can improve without a meaningful percent. */
export function comparableAnnual(
  a: SelectedValue | null,
  b: SelectedValue | null,
  currentPeriod?: AnnualPeriod,
  previousPeriod?: AnnualPeriod,
): string | null {
  if (!a || !b) return '缺少相邻年度指标';
  if (
    currentPeriod &&
    previousPeriod &&
    days(previousPeriod.end, currentPeriod.start) !== 2
  )
    return '财年期间不连续';
  if (a.unit !== b.unit || a.tag !== b.tag) return '币种或指标标签不一致';
  const gap = days(b.end, a.end) - 1;
  if (gap < 360 || gap > 380 || Boolean(a.start) !== Boolean(b.start))
    return '不是可比的相邻完整财年';
  if (
    a.start &&
    b.start &&
    (days(b.end, a.start) !== 2 ||
      Math.abs(days(a.start, a.end) - days(b.start, b.end)) > 8)
  )
    return '财年期间不连续或长度不可比';
  return null;
}

export function extractAnnualTrends(
  facts: CompanyFacts,
  filings: Filing[],
  tickers: string[],
  fetchedAt: string,
  asOf: string,
  sources: string[],
  datasetId: string,
): TrendDataset {
  const eligible = filings.filter(
    (f) =>
      annualForm(f.form) &&
      validDate(f.end) &&
      validDate(f.filed) &&
      f.filed <= asOf &&
      f.end <= asOf,
  );
  const filingMap = new Map(eligible.map((f) => [f.accession, f]));
  const ends = [...new Set(eligible.map((f) => f.end))].sort().reverse();
  if (!ends.length)
    throw new Error('SEC_NO_ANNUAL: 未找到截至日期内的年度申报');
  const gaap = facts.facts?.['us-gaap'] ?? {};
  function rows(tag: string, end: string, duration: boolean): SelectedValue[] {
    return Object.entries(gaap[tag]?.units ?? {}).flatMap(([unit, entries]) => {
      if (!/^[A-Z]{3}$/.test(unit)) return [];
      return entries.flatMap((f) => {
        const filing = filingMap.get(f.accn);
        if (
          !filing ||
          f.filed !== filing.filed ||
          f.form !== filing.form ||
          f.end !== end ||
          !Number.isFinite(f.val) ||
          Math.abs(f.val) > Number.MAX_SAFE_INTEGER ||
          (duration ? !f.start || !fullYear(f.start, end) : Boolean(f.start))
        )
          return [];
        return [
          {
            value: f.val,
            unit,
            tag: `us-gaap:${tag}`,
            ...(f.start ? { start: f.start } : {}),
            end,
            accession: f.accn,
            filed: f.filed,
            form: f.form,
            source: filing.url,
          },
        ];
      });
    });
  }
  const years: AnnualPeriod[] = [];
  const excludedPeriods: TrendDataset['excludedPeriods'] = [];
  for (const end of ends) {
    if (years.length === 3) break;
    const anchor = metricDefinitions
      .filter((d) => d.duration)
      .flatMap((d) => d.tags.flatMap((t) => rows(t, end, true)));
    const newest = anchor
      .map((v) => v.filed)
      .sort()
      .at(-1);
    const starts = [
      ...new Set(anchor.filter((v) => v.filed === newest).map((v) => v.start!)),
    ];
    const priorEnd = ends.find((e) => e < end);
    const filing = eligible
      .filter((f) => f.end === end)
      .sort(
        (a, b) =>
          b.filed.localeCompare(a.filed) ||
          b.accession.localeCompare(a.accession),
      )[0];
    // A short transition's comparative annual values must not redefine its own report period.
    const own = metricDefinitions
      .filter((d) => d.duration)
      .flatMap((d) =>
        d.tags.flatMap((t) =>
          Object.values(gaap[t]?.units ?? {})
            .flat()
            .filter(
              (f) =>
                f.accn === filing.accession &&
                f.end === end &&
                f.start &&
                validDate(f.start),
            ),
        ),
      );
    const hasOwnFull = own.some((f) => fullYear(f.start!, end));
    if (
      starts.length !== 1 ||
      (own.length > 0 && !hasOwnFull) ||
      (priorEnd &&
        days(priorEnd, end) >= 360 &&
        days(priorEnd, end) <= 380 &&
        days(priorEnd, starts[0]) !== 2)
    ) {
      excludedPeriods.push({
        end,
        reason:
          '未能确认唯一完整年度期间；可能为缺失、财年变更、短过渡期或期间冲突',
      });
      continue;
    }
    years.push({ start: starts[0], end, filing });
  }
  years.reverse();
  function choose(
    candidates: SelectedValue[],
    tags: readonly string[],
  ): { value: SelectedValue | null; reason: string | null } {
    if (!candidates.length)
      return {
        value: null,
        reason: '没有满足完整年度期间与官方申报来源约束的标准货币事实',
      };
    const newest = candidates
      .map((v) => v.filed)
      .sort()
      .at(-1)!;
    const latest = candidates.filter((v) => v.filed === newest);
    const tag = tags.find((t) => latest.some((v) => v.tag === `us-gaap:${t}`))!;
    const selected = latest.filter((v) => v.tag === `us-gaap:${tag}`);
    if (
      new Set(
        selected.map((v) =>
          JSON.stringify([v.value, v.unit, v.start ?? null, v.end]),
        ),
      ).size !== 1
    )
      return {
        value: null,
        reason: '最新披露存在多币种或冲突事实，需人工核验',
      };
    return {
      value: selected.sort((a, b) => b.accession.localeCompare(a.accession))[0],
      reason: null,
    };
  }
  const metrics: TrendMetric[] = metricDefinitions.map((d) => {
    const annual: AnnualPoint[] = years.map((y) => {
      const picked = choose(
        d.tags
          .flatMap((t) => rows(t, y.end, d.duration))
          .filter((v) => !d.duration || v.start === y.start),
        d.tags,
      );
      return {
        end: y.end,
        value: picked.value,
        missingReason: picked.reason,
        yoyPercent: null,
        yoyReason: null,
      };
    });
    annual.forEach((p, i) => {
      if (!i) {
        p.yoyReason = '展示范围最早年度没有更早可比基数';
        return;
      }
      const reason = comparableAnnual(
        p.value,
        annual[i - 1].value,
        years[i],
        years[i - 1],
      );
      const yoy = reason
        ? { percent: null, reason }
        : calculateYoy(p.value, annual[i - 1].value);
      p.yoyPercent = yoy.percent;
      p.yoyReason = yoy.reason;
    });
    return { key: d.key, label: d.label, basis: d.basis, annual };
  });
  const evidence: AnnualEvidence[] = [];
  const verifiedFacts: VerifiedFact[] = [];
  const eid = (key: string, end: string) => `${datasetId}:${key}:${end}`;
  for (const m of metrics) {
    m.annual.forEach((p, i) => {
      if (!p.value) return;
      const id = eid(m.key, p.end);
      evidence.push({
        ...p.value,
        id,
        metricKey: m.key,
        label: m.label,
        basis: m.basis,
        period: p.end,
        currency: p.value.unit,
      });
      verifiedFacts.push({
        id: `${id}:value`,
        content: `${m.label}（财年期末 ${p.end}）为 ${p.value.value.toLocaleString('en-US')} ${p.value.unit}。`,
        evidenceIds: [id],
      });
      const prev = m.annual[i - 1];
      if (
        prev?.value &&
        !comparableAnnual(p.value, prev.value, years[i], years[i - 1])
      ) {
        const delta = p.value.value - prev.value.value;
        verifiedFacts.push({
          id: `${id}:change`,
          content: `${m.label}从 ${prev.end} 到 ${p.end} ${delta > 0 ? '增加' : delta < 0 ? '减少' : '持平'}${delta ? ` ${Math.abs(delta).toLocaleString('en-US')} ${p.value.unit}` : ''}；${p.yoyPercent === null ? `常规同比未计算：${p.yoyReason}` : `同比 ${p.yoyPercent.toFixed(2)}%`}。`,
          evidenceIds: [eid(m.key, prev.end), id],
        });
      }
    });
    if (
      m.annual.length === 3 &&
      m.annual.every((p) => p.value) &&
      m.annual
        .slice(1)
        .every(
          (p, i) =>
            !comparableAnnual(
              p.value,
              m.annual[i].value,
              years[i + 1],
              years[i],
            ),
        )
    ) {
      const values = m.annual.map((p) => p.value!.value);
      const direction =
        values[1] > values[0] && values[2] > values[1]
          ? '连续增加'
          : values[1] < values[0] && values[2] < values[1]
            ? '连续减少'
            : values.every((v) => v === values[0])
              ? '连续持平'
              : null;
      if (direction)
        verifiedFacts.push({
          id: `${datasetId}:${m.key}:chain`,
          content: `${m.label}在 ${years.map((y) => y.end).join(' → ')} 三个完整且可比财年${direction}（金额方向，不代表经营原因、盈利质量或偿债能力）。`,
          evidenceIds: m.annual.map((p) => eid(m.key, p.end)),
        });
    }
  }
  return {
    schemaVersion: 3,
    datasetId,
    company: {
      cik: String(facts.cik).padStart(10, '0'),
      name: facts.entityName,
      tickers,
    },
    fetchedAt,
    asOf,
    requestedYears: 3,
    restatementPolicy: 'latest_disclosed_as_of',
    years,
    excludedPeriods,
    metrics,
    evidence,
    verifiedFacts,
    sources,
    warnings: [
      '历史值统一采用截至研究日期内最新年度披露的同期间标准事实（包括修订及后续年度比较数）；不是原始披露或全量重述保证。保留逐值出处，未披露的新值不推算。',
      '仅支持公司整体 US-GAAP 标准标签；完整年度需实际流量期间及年度申报共同确认（360–380 天，覆盖五十二/五十三周）。短过渡期不充当年度；异常期间保守排除。',
      '标签和币种变化保留实际数值，停止跨口径同比与连续趋势；缺失不补零、不拼季度、不插值。总负债不等于有息债务。',
      ...(years.length < 3
        ? [
            `仅可靠取得 ${years.length} 个完整财年，缺少 ${3 - years.length} 个；不能声称完整三年结论。`,
          ]
        : []),
      ...excludedPeriods.map((p) => `排除 ${p.end}：${p.reason}。`),
    ],
  };
}
