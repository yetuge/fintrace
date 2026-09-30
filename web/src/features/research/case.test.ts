import { describe, expect, it } from 'vitest';
import {
  annualGrowth,
  buildReport,
  cloudShare,
  claims,
  financials,
  growth,
  sources,
} from './case';

describe('Microsoft FY2024 research case', () => {
  it('recomputes reported annual growth and segment contribution from raw amounts', () => {
    expect(financials.current - financials.previous).toBe(33207);
    expect(financials.cloudCurrent - financials.cloudPrevious).toBe(17455);
    expect(annualGrowth).toBeCloseTo(15.66996, 4);
    expect(cloudShare).toBeCloseTo(52.56422, 4);
    expect(
      growth(financials.quarterCurrent, financials.quarterPrevious),
    ).toBeCloseTo(15.19514, 4);
  });
  it('exports resolvable citations and preserves the unsupported AI attribution', () => {
    const report = buildReport();
    for (const claim of claims) {
      expect(report).toContain(claim.title);
      for (const sourceId of claim.sourceIds) {
        const source = sources.find((s) => s.id === sourceId);
        expect(source).toBeDefined();
        expect(report).toContain(source!.url);
        expect(report).toContain(source!.location);
      }
    }
    expect(claims.find((c) => c.id === 'C4')).toMatchObject({
      kind: 'open',
      sourceIds: [],
    });
    expect(report).toContain('不是 Agent 实际执行记录');
    expect(report).toContain('来源不足，保留待确认');
    expect(buildReport(true)).toContain('未持久化');
    expect(buildReport(true)).toContain('需要更细披露');
  });
});
