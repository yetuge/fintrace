import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineMcpTool, type McpToolDefinition } from '../mcp-tool-types.js';
import { createSecFetch, fetchCompany, type SecFetch } from './sec-client.js';
import {
  withDataContext,
  dataContextBanner,
  type SecDataContext,
} from './sec-data-context.js';
import { extractAnnualTrends, type TrendDataset } from './sec-trends.js';
import {
  buildTrendChartData,
  renderTrendSvg,
  renderTrendReport,
} from './sec-trend-report.js';
import {
  buildEvidenceDataset,
  trendFindingSchema,
  normalizeFindings,
  type EvidenceDataset,
  type Finding,
} from './sec-evidence.js';
import {
  extractFinancials,
  filingsFromColumns,
  type CompanyFacts,
  type FinancialDataset,
  type SelectedValue,
} from './sec-metrics.js';

async function researchRoot(workspace: string): Promise<string> {
  const realWorkspace = await fs.realpath(workspace);
  const target = path.join(realWorkspace, 'financial-research');
  await fs.mkdir(target, { recursive: true });
  if ((await fs.realpath(target)) !== target)
    throw new Error('SEC_PATH: financial-research 不得是指向其他目录的链接');
  return target;
}
const digest = (data: string) =>
  createHash('sha256').update(data).digest('hex');
const escape = (text: string) =>
  text.replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
const format = (value: SelectedValue | null) =>
  value
    ? `${Number.isInteger(value.value) ? value.value.toLocaleString('en-US') : String(value.value)} ${value.unit}`
    : '缺失';

export function renderSecReport(
  dataset: EvidenceDataset,
  findings: Finding[],
): string {
  const links = [
    ...new Set([
      ...dataset.sources,
      dataset.latestAnnual.url,
      ...dataset.metrics.flatMap((m) =>
        [m.current?.source, m.previous?.source].filter((url): url is string =>
          Boolean(url),
        ),
      ),
    ]),
  ];
  const ref = (url: string) => `[${links.indexOf(url) + 1}]`;
  const lines = [
    `# ${escape(dataset.company.name)} 年度财务分析`,
    '',
    `CIK：${dataset.company.cik}；股票代码：${dataset.company.tickers.map(escape).join(', ') || '未提供'}。`,
    '',
    `数据抓取时间：${dataset.fetchedAt}。申报筛选截至：${dataset.asOf}（UTC）。这不是实时行情或当日财务余额。`,
    '',
    `最新年度申报：${dataset.latestAnnual.form}，报告期末 ${dataset.latestAnnual.end}，提交日期 ${dataset.latestAnnual.filed}，accession ${dataset.latestAnnual.accession} ${ref(dataset.latestAnnual.url)}。`,
    '',
    `年度流量期间：${dataset.annualStart ?? '缺失'} 至 ${dataset.latestAnnual.end}；余额指标为该期末值。金额为 SEC JSON 中的基础货币单位，不进行千/百万倍数推断。`,
    '',
    '## 指标（代码提取与计算）',
    '',
    '| 指标 | 本期 | 上期 | 同比 |',
    '| --- | ---: | ---: | ---: |',
    ...dataset.metrics.map(
      (m) =>
        `| ${m.label} | ${format(m.current)}${m.current ? ' ' + ref(m.current.source) : ''} | ${format(m.previous)}${m.previous ? ' ' + ref(m.previous.source) : ''} | ${m.yoyPercent === null ? '不可计算' : m.yoyPercent.toFixed(2) + '%'} |`,
    ),
    '',
    '同比公式：(本期 − 上期) / 上期 × 100%；上期为零或负数、标签或币种不一致、期间不可比时不计算。相邻年度允许正常的五十二/五十三周年差异。',
    '',
    '## 口径与可核验记录',
    '',
    ...dataset.metrics.flatMap((m) => [
      `- **${m.label}**：${m.basis}。`,
      ...(
        [
          ['本期', m.current],
          ['上期', m.previous],
        ] as const
      )
        .filter(([, v]) => v)
        .map(
          ([label, v]) =>
            `  - ${label}：${v!.tag}；${v!.start ? v!.start + ' 至 ' : '期末 '}${v!.end}；${v!.unit}；${v!.form}；filed ${v!.filed}；accession ${v!.accession} ${ref(v!.source)}。`,
        ),
      ...(m.missingReason ? [`  - 缺失原因：${m.missingReason}。`] : []),
      ...(m.yoyReason ? [`  - 同比未计算：${m.yoyReason}。`] : []),
    ]),
    '',
    '## 主要发现（逐条分类与证据）',
    '',
    ...findings.flatMap((f, i) => [
      `### 发现 ${i + 1} · ${f.type === 'direct_fact' ? '直接事实（代码核验）' : f.type === 'interpretation' ? '分析解释（未语义核验）' : '待验证判断'}`,
      '',
      escape(f.content),
      '',
      `关联证据：${f.evidenceIds.length ? f.evidenceIds.map((id) => `[${id}](#evidence-${dataset.evidence.findIndex((e) => e.id === id) + 1})`).join('、') : '无可用指标证据'}。`,
      ...(f.requestedType !== f.type
        ? ['原始类型：分析解释；当前只有指标依据，降为待验证判断。']
        : []),
      ...f.limitations.map((l) => `- 限制 / 尚缺：${escape(l)}`),
      '',
    ]),
    '',
    '直接事实的内容由代码事实目录生成，模型自由文本不能取得该标签。分析解释与待验证判断的引用只表示关联，不代表结论已得到充分支持。本轮模型定性解释保守归为待验证判断；未读取申报正文，未完成正文或因果核验。文件哈希和格式校验不等于语义核验。',
    '',
    '## 指标证据目录',
    '',
    ...dataset.evidence.flatMap((e, i) => [
      `<a id="evidence-${i + 1}"></a>`,
      `- **${e.id}**：${e.label}（${e.period === 'current' ? '本期' : '上期'}）；${e.tag}；${format(e)}；${e.start ? e.start + ' 至 ' : '期末 '}${e.end}；filed ${e.filed}；accession ${e.accession}；[SEC 官方申报](${e.source})。`,
    ]),
    '',
    '## 限制',
    '',
    ...dataset.warnings.map((w) => `- ${w}`),
    '',
    '原始 Company Facts 与 Submissions JSON 保存于同目录 raw.json，版本二结构化指标与证据见 metrics.json，发现记录见 findings.json，完整性摘要见 manifest.json。',
    '',
    '## SEC 官方来源',
    '',
    ...links.map(
      (url, i) =>
        `${i + 1}. [${url.includes('/Archives/') ? '年度申报文件' : url.includes('companyfacts') ? 'Company Facts JSON' : url.includes('tickers') ? '股票代码与 CIK 映射' : 'Submissions JSON'}](${url})`,
    ),
    '',
  ];
  return dataContextBanner(dataset.dataContext) + lines.join('\n');
}

export function createSecTools(
  workspace: string,
  request: SecFetch = createSecFetch(),
  clock?: { fetchedAt?: string; asOf?: string; dataContext?: SecDataContext },
): McpToolDefinition<any>[] {
  return [
    defineMcpTool(
      'fetch_sec_financials',
      '获取真实 SEC 官方年度财务数据。输入英文公司名称、股票代码或 CIK。三年趋势研究传 years=3，选择最近三个完整财年，生成逐年指标、可比同比、代码趋势事实和 SVG 图表；省略 years 或 1 保持单年度研究。全部数值由代码提取，缺失不补造。保存原始 JSON、指标、图表及完整性摘要到当前工作区。成功后必须调用 save_sec_report 保存带证据报告；失败明确说明，不切换模拟数据。',
      {
        company: z.string().trim().min(1).max(160),
        years: z
          .union([z.literal(1), z.literal(3)])
          .optional()
          .describe(
            '最近三个完整财年趋势研究必须传 3；省略或 1 保持单年度行为',
          ),
      },
      async ({ company, years }, extra) => {
        const signal = (extra as { signal?: AbortSignal })?.signal;
        const fetched = await fetchCompany(
          company,
          request,
          signal,
          years === 3 ? 5 : 2,
        );
        signal?.throwIfAborted();
        const fetchedAt = clock?.fetchedAt ?? new Date().toISOString();
        const asOf = clock?.asOf ?? fetchedAt.slice(0, 10);
        const datasetId = `${fetched.cik}-${randomUUID()}`;
        const dataset = withDataContext(
          years === 3
            ? extractAnnualTrends(
                fetched.facts,
                fetched.filings,
                fetched.tickers,
                fetchedAt,
                asOf,
                fetched.raw.map((r) => r.url),
                datasetId,
              )
            : buildEvidenceDataset(
                extractFinancials(
                  fetched.facts,
                  fetched.filings,
                  fetched.tickers,
                  fetchedAt,
                  asOf,
                  fetched.raw.map((r) => r.url),
                ),
                datasetId,
              ),
          clock?.dataContext,
        );
        const root = await researchRoot(workspace);
        const directory = path.join(root, datasetId);
        await fs.mkdir(directory);
        const raw =
          JSON.stringify(
            {
              responses: fetched.raw,
              ...(clock?.dataContext ? { dataContext: clock.dataContext } : {}),
            },
            null,
            2,
          ) + '\n';
        const metrics = JSON.stringify(dataset, null, 2) + '\n';
        await fs.writeFile(path.join(directory, 'raw.json'), raw, {
          flag: 'wx',
        });
        await fs.writeFile(path.join(directory, 'metrics.json'), metrics, {
          flag: 'wx',
        });
        const chartFiles: Record<string, string> = {};
        if (dataset.schemaVersion === 3) {
          const chart = buildTrendChartData(dataset);
          chartFiles['chart-data.json'] = JSON.stringify(chart, null, 2) + '\n';
          chartFiles['trends.svg'] = renderTrendSvg(chart);
          for (const [name, contents] of Object.entries(chartFiles))
            await fs.writeFile(path.join(directory, name), contents, {
              flag: 'wx',
            });
        }
        await fs.writeFile(
          path.join(directory, 'manifest.json'),
          JSON.stringify(
            {
              schemaVersion: dataset.schemaVersion,
              datasetId,
              ...(dataset.dataContext
                ? { dataContext: dataset.dataContext }
                : {}),
              rawSha256: digest(raw),
              metricsSha256: digest(metrics),
              ...(dataset.schemaVersion === 3
                ? {
                    chartHashes: Object.fromEntries(
                      Object.entries(chartFiles).map(([name, contents]) => [
                        name,
                        digest(contents),
                      ]),
                    ),
                    completeness: {
                      requestedYears: 3,
                      availableYears: dataset.years.map((y) => y.end),
                      missingValues: dataset.metrics.flatMap((m) =>
                        m.annual
                          .filter((p) => !p.value)
                          .map((p) => ({
                            metric: m.key,
                            end: p.end,
                            reason: p.missingReason,
                          })),
                      ),
                      excludedPeriods: dataset.excludedPeriods,
                    },
                  }
                : {}),
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                directory: `financial-research/${datasetId}`,
                ...dataset,
                nextStep:
                  '调用 save_sec_report。findings 每项包含 type、evidence_ids、limitations；直接事实 type=direct_fact 必须从 verifiedFacts 选择 fact_id 和完整 evidenceIds，内容由代码生成。其他发现提供 content 与具体尚缺证据，不含数字；interpretation 在指标证据范围内保守降为 unverified。不要宣称已读取正文或完成因果核验。',
              }),
            },
          ],
        };
      },
    ),
    defineMcpTool(
      'save_sec_report',
      '保存版本二单年度或版本三三年趋势带证据报告。findings 是结构化记录：type 为 direct_fact/interpretation/unverified，evidence_ids 只能引用本数据集 evidence。direct_fact 必须选择 verifiedFacts 中的 fact_id 及完整 evidenceIds，发现内容由代码生成；模型 content 不会成为已核验事实。定性 content 不含数字，limitations 必须具体说明尚缺信息；仅有指标不足以核验定性解释，interpretation 保守降为 unverified。未读取正文或核验因果。保存 findings.json 与 report.md，不覆盖历史报告，不用 write 重写。',
      {
        dataset_id: z
          .string()
          .regex(
            /^\d{10}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
        findings: z.array(trendFindingSchema).min(1).max(6),
      },
      async ({ dataset_id, findings }) => {
        const directory = path.join(await researchRoot(workspace), dataset_id);
        if ((await fs.realpath(directory)) !== directory)
          throw new Error('SEC_PATH: 数据集路径不得使用链接');
        const raw = await fs.readFile(path.join(directory, 'raw.json'), 'utf8');
        const metrics = await fs.readFile(
          path.join(directory, 'metrics.json'),
          'utf8',
        );
        const manifest = JSON.parse(
          await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
        ) as { rawSha256: string; metricsSha256: string };
        if (
          digest(raw) !== manifest.rawSha256 ||
          digest(metrics) !== manifest.metricsSha256
        )
          throw new Error(
            'SEC_INTEGRITY: 原始数据或指标文件已变更，请重新获取数据',
          );
        const saved = JSON.parse(metrics) as
          | EvidenceDataset
          | FinancialDataset
          | TrendDataset;
        if (
          (saved.schemaVersion !== 2 && saved.schemaVersion !== 3) ||
          saved.datasetId !== dataset_id
        )
          throw new Error(
            'SEC_VERSION: 旧产物只读保留，请重新获取生成版本二报告',
          );
        const dataset =
          saved.schemaVersion === 3
            ? saved
            : buildEvidenceDataset({ ...saved, schemaVersion: 1 }, dataset_id);
        if (dataset.schemaVersion === 3) {
          const responses = JSON.parse(raw).responses as {
            url: string;
            body: any;
          }[];
          const facts = responses.find((r) => r.url.includes('/companyfacts/'))
            ?.body as CompanyFacts;
          const filings = responses
            .filter((r) => r.url.includes('/submissions/'))
            .flatMap((r) =>
              filingsFromColumns(
                r.body.filings?.recent ?? r.body,
                dataset.company.cik,
              ),
            );
          assert.deepEqual(
            dataset,
            withDataContext(
              extractAnnualTrends(
                facts,
                filings,
                dataset.company.tickers,
                dataset.fetchedAt,
                dataset.asOf,
                dataset.sources,
                dataset_id,
              ),
              JSON.parse(raw).dataContext,
            ),
            'SEC_INTEGRITY: 三年数据与代码事实必须从原始快照重建',
          );
          const chart = buildTrendChartData(dataset);
          for (const [name, contents] of [
            ['chart-data.json', JSON.stringify(chart, null, 2) + '\n'],
            ['trends.svg', renderTrendSvg(chart)],
          ]) {
            if (
              (await fs.readFile(path.join(directory, name), 'utf8')) !==
              contents
            )
              throw new Error('SEC_CHART: 图表或图表数据不一致，请重新获取');
          }
        }
        const records = normalizeFindings(dataset, findings);
        const report =
          dataset.schemaVersion === 3
            ? renderTrendReport(dataset, records)
            : renderSecReport(dataset, records);
        const findingsText =
          JSON.stringify(
            {
              schemaVersion: dataset.schemaVersion,
              datasetId: dataset_id,
              inputs: findings,
              findings: records,
            },
            null,
            2,
          ) + '\n';
        // Preflight both outputs before writing: retries are idempotent, history is immutable.
        for (const [name, contents] of [
          ['report.md', report],
          ['findings.json', findingsText],
        ]) {
          try {
            if (
              (await fs.readFile(path.join(directory, name), 'utf8')) !==
              contents
            )
              throw new Error('SEC_EXISTS: 已有报告或发现不同，请新建研究');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        for (const [name, contents] of [
          ['findings.json', findingsText],
          ['report.md', report],
        ]) {
          try {
            await fs.writeFile(path.join(directory, name), contents, {
              flag: 'wx',
            });
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
              (await fs.readFile(path.join(directory, name), 'utf8')) !==
                contents
            )
              throw error;
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                saved: true,
                report: `financial-research/${dataset_id}/report.md`,
                metrics: `financial-research/${dataset_id}/metrics.json`,
                raw: `financial-research/${dataset_id}/raw.json`,
                findings: `financial-research/${dataset_id}/findings.json`,
                ...(dataset.schemaVersion === 3
                  ? {
                      chart: `financial-research/${dataset_id}/trends.svg`,
                      chartData: `financial-research/${dataset_id}/chart-data.json`,
                    }
                  : {}),
                classification: records.map((f) => ({
                  type: f.type,
                  verification: f.verification,
                })),
                reportSha256: digest(report),
              }),
            },
          ],
        };
      },
    ),
  ];
}
