/** Versioned, dataset-scoped metric evidence. Free prose is never a verified fact. */
import { z } from 'zod';
import {
  calculateYoy,
  type FinancialDataset,
  type SelectedValue,
} from './sec-metrics.js';

export interface MetricEvidence extends SelectedValue {
  id: string;
  metricKey: string;
  label: string;
  basis: string;
  period: 'current' | 'previous';
}
export interface VerifiedFact {
  id: string;
  content: string;
  evidenceIds: string[];
}
export interface EvidenceDataset extends Omit<
  FinancialDataset,
  'schemaVersion'
> {
  schemaVersion: 2;
  datasetId: string;
  evidence: MetricEvidence[];
  verifiedFacts: VerifiedFact[];
}
export const findingSchema = z
  .object({
    type: z.enum(['direct_fact', 'interpretation', 'unverified']),
    content: z.string().trim().min(1).max(500).optional(),
    evidence_ids: z.array(z.string().min(1).max(150)).max(10),
    fact_id: z.string().max(150).optional(),
    limitations: z.array(z.string().trim().min(1).max(500)).max(6),
  })
  .strict();
export type FindingInput = z.infer<typeof findingSchema>;
export interface Finding {
  content: string;
  type: FindingInput['type'];
  requestedType: FindingInput['type'];
  evidenceIds: string[];
  limitations: string[];
  factId?: string;
  verification: 'code_verified' | 'not_semantically_verified';
}
const amount = (v: SelectedValue) =>
  `${v.value.toLocaleString('en-US')} ${v.unit}`;
const period = (v: SelectedValue) =>
  v.start ? `${v.start} 至 ${v.end}` : `期末 ${v.end}`;

export function buildEvidenceDataset(
  data: FinancialDataset,
  datasetId: string,
): EvidenceDataset {
  const evidence: MetricEvidence[] = [];
  const verifiedFacts: VerifiedFact[] = [];
  for (const metric of data.metrics) {
    for (const slot of ['current', 'previous'] as const) {
      const value = metric[slot];
      if (!value) continue;
      const id = `${datasetId}:${metric.key}:${slot}`;
      evidence.push({
        id,
        metricKey: metric.key,
        label: metric.label,
        basis: metric.basis,
        period: slot,
        ...value,
      });
      verifiedFacts.push({
        id: `${datasetId}:${metric.key}:${slot}:value`,
        content: `${metric.label}（${slot === 'current' ? '本期' : '上期'}，${period(value)}）为 ${amount(value)}。`,
        evidenceIds: [id],
      });
    }
    const yoy = calculateYoy(metric.current, metric.previous).percent;
    if (yoy !== null) {
      verifiedFacts.push({
        id: `${datasetId}:${metric.key}:yoy`,
        content: `${metric.label}较可比上期${yoy > 0 ? '增长' : yoy < 0 ? '下降' : '持平'}${yoy === 0 ? '' : ` ${Math.abs(yoy).toFixed(2)}%`}。`,
        evidenceIds: [
          `${datasetId}:${metric.key}:current`,
          `${datasetId}:${metric.key}:previous`,
        ],
      });
    }
  }
  for (let i = 0; i < data.metrics.length; i++) {
    for (const right of data.metrics.slice(i + 1)) {
      const left = data.metrics[i];
      const a = left.current,
        b = right.current;
      const x = calculateYoy(a, left.previous).percent;
      const y = calculateYoy(b, right.previous).percent;
      if (
        !a ||
        !b ||
        x === null ||
        y === null ||
        a.unit !== b.unit ||
        a.start !== b.start ||
        a.end !== b.end ||
        left.previous?.start !== right.previous?.start ||
        left.previous?.end !== right.previous?.end
      )
        continue;
      verifiedFacts.push({
        id: `${datasetId}:${left.key}:${right.key}:yoy_comparison`,
        content: `${left.label}同比变动率（${x.toFixed(2)}%）${x > y ? '高于' : x < y ? '低于' : '等于'}${right.label}（${y.toFixed(2)}%）；仅比较同期间数值，不代表盈利质量或因果关系。`,
        evidenceIds: [left, right].flatMap((m) => [
          `${datasetId}:${m.key}:current`,
          `${datasetId}:${m.key}:previous`,
        ]),
      });
    }
  }
  return { ...data, schemaVersion: 2, datasetId, evidence, verifiedFacts };
}

/** Rebuild from saved metrics, never trust a caller-supplied evidence catalog. */
export function normalizeFindings(
  data: EvidenceDataset,
  inputs: FindingInput[],
): Finding[] {
  const known = new Set(data.evidence.map((e) => e.id));
  return inputs.map((input) => {
    const finding = findingSchema.parse(input);
    const ids = [...new Set(finding.evidence_ids)];
    if (ids.some((id) => !known.has(id)))
      throw new Error('SEC_EVIDENCE: 引用不存在或属于其他数据集');
    if (finding.type === 'direct_fact') {
      const fact = data.verifiedFacts.find((f) => f.id === finding.fact_id);
      if (
        !fact ||
        ids.length !== fact.evidenceIds.length ||
        fact.evidenceIds.some((id) => !ids.includes(id))
      )
        throw new Error(
          'SEC_FACT: 直接事实必须选择本数据集代码事实及其完整证据',
        );
      return {
        content: fact.content,
        type: 'direct_fact',
        requestedType: finding.type,
        evidenceIds: fact.evidenceIds,
        limitations: [
          '仅核验结构化指标及数值关系；未读取申报正文，不作因果核验。',
        ],
        factId: fact.id,
        verification: 'code_verified',
      };
    }
    if (!finding.content || !finding.limitations.length)
      throw new Error('SEC_FINDING: 待验证判断必须提供发现内容和具体缺失证据');
    if (/[0-9０-９]|\b(?:NaN|Infinity)\b/.test(finding.content))
      throw new Error('SEC_FINDING: 自由文本不得补造数值，请选择代码事实');
    return {
      content: finding.content,
      type: 'unverified',
      requestedType: finding.type,
      evidenceIds: ids,
      limitations: [
        ...finding.limitations,
        ...(ids.length ? [] : ['当前数据集没有可关联的指标证据。']),
        '指标引用只证明关联；定性解释的充分性、正文与因果均未核验。',
      ],
      verification: 'not_semantically_verified',
    };
  });
}
