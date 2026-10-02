/** Synthetic SEC-shaped data for tests only. Not downloaded SEC facts and never a runtime fallback.
 * Covers calendar periods, base USD amounts and comparative/amended disclosures.
 * Individual tests mutate fresh instances for currency, duplicates, missing and incomparable cases. */
import {
  filingsFromColumns,
  type CompanyFacts,
  type Fact,
} from '../../container/agent-runner/src/financial/sec-metrics.js';
export const columns = {
  accessionNumber: [
    '0000000001-25-000001',
    '0000000001-24-000001',
    '0000000001-25-000002',
  ],
  form: ['10-K', '10-K', '10-K/A'],
  filingDate: ['2025-02-01', '2024-02-01', '2025-03-01'],
  reportDate: ['2024-12-31', '2023-12-31', '2024-12-31'],
  primaryDocument: ['annual.htm', 'prior.htm', 'amended.htm'],
};
export const filings = filingsFromColumns(columns, '0000000001');
export function fact(
  val: number,
  end = '2024-12-31',
  start: string | undefined = '2024-01-01',
  accn = columns.accessionNumber[0],
): Fact {
  const i = columns.accessionNumber.indexOf(accn);
  return {
    val,
    end,
    ...(start ? { start } : {}),
    accn,
    filed: columns.filingDate[i],
    form: columns.form[i],
    fy: 2024,
    fp: 'FY',
  };
}
export function fixture(): CompanyFacts {
  const duration = [
    fact(120),
    fact(100, '2023-12-31', '2023-01-01'),
    fact(90, '2023-12-31', '2023-01-01', columns.accessionNumber[1]),
  ];
  const instant = [
    fact(50, '2024-12-31', undefined),
    fact(40, '2023-12-31', undefined),
  ];
  // Avoid the function's default start in instantaneous fixtures.
  instant.forEach((f) => delete f.start);
  return {
    cik: 1,
    entityName: 'Example Corp',
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: duration },
        },
        NetIncomeLoss: {
          units: { USD: duration.map((f) => ({ ...f, val: f.val / 10 })) },
        },
        NetCashProvidedByUsedInOperatingActivities: {
          units: { USD: duration.map((f) => ({ ...f, val: f.val / 5 })) },
        },
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: instant } },
        Liabilities: {
          units: { USD: instant.map((f) => ({ ...f, val: f.val * 3 })) },
        },
      },
    },
  };
}
