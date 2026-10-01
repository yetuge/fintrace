import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { defineMcpTool, type McpToolDefinition } from '../mcp-tool-types.js';
import { createSecFetch, fetchCompany, type SecFetch } from './sec-client.js';
import {
  extractFinancials,
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
  dataset: FinancialDataset,
  findings: string[],
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
    '## 主要发现（Agent 定性分析）',
    '',
    ...findings.map((f) => `- ${escape(f)}`),
    '',
    '以上发现由 Agent 基于工具返回的指标生成；数值及引用由代码写入。因果判断需结合申报正文核查。',
    '',
    '## 限制',
    '',
    ...dataset.warnings.map((w) => `- ${w}`),
    '',
    '原始 Company Facts 与 Submissions JSON 保存于同目录 raw.json，结构化指标见 metrics.json，完整性摘要见 manifest.json。',
    '',
    '## SEC 官方来源',
    '',
    ...links.map(
      (url, i) =>
        `${i + 1}. [${url.includes('/Archives/') ? '年度申报文件' : url.includes('companyfacts') ? 'Company Facts JSON' : url.includes('tickers') ? '股票代码与 CIK 映射' : 'Submissions JSON'}](${url})`,
    ),
    '',
  ];
  return lines.join('\n');
}

export function createSecTools(
  workspace: string,
  request: SecFetch = createSecFetch(),
): McpToolDefinition<any>[] {
  return [
    defineMcpTool(
      'fetch_sec_financials',
      '获取真实 SEC 官方年度财务数据。输入英文公司名称、股票代码或 CIK。由代码选择最近年度、核验财务期间/币种/修订来源并计算营收、净利润、经营现金流、现金及总负债与可靠同比；保存原始 JSON 和 metrics.json 到当前工作区。不得用其他工具或模型记忆补造缺失数值。成功后必须调用 save_sec_report 保存带引用报告。失败时说明原因，不切换模拟数据。',
      { company: z.string().trim().min(1).max(160) },
      async ({ company }, extra) => {
        const signal = (extra as { signal?: AbortSignal })?.signal;
        const fetched = await fetchCompany(company, request, signal);
        signal?.throwIfAborted();
        const fetchedAt = new Date().toISOString();
        const dataset = extractFinancials(
          fetched.facts,
          fetched.filings,
          fetched.tickers,
          fetchedAt,
          fetchedAt.slice(0, 10),
          fetched.raw.map((r) => r.url),
        );
        const datasetId = `${fetched.cik}-${randomUUID()}`;
        const root = await researchRoot(workspace);
        const directory = path.join(root, datasetId);
        await fs.mkdir(directory);
        const raw = JSON.stringify({ responses: fetched.raw }, null, 2) + '\n';
        const metrics = JSON.stringify(dataset, null, 2) + '\n';
        await fs.writeFile(path.join(directory, 'raw.json'), raw, {
          flag: 'wx',
        });
        await fs.writeFile(path.join(directory, 'metrics.json'), metrics, {
          flag: 'wx',
        });
        await fs.writeFile(
          path.join(directory, 'manifest.json'),
          JSON.stringify(
            { rawSha256: digest(raw), metricsSha256: digest(metrics) },
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
                datasetId,
                directory: `financial-research/${datasetId}`,
                ...dataset,
                nextStep:
                  '调用 save_sec_report，findings 只写基于这些指标的定性发现，不含数字、不推断缺失值或无证据因果。数值表与来源自动写入报告。',
              }),
            },
          ],
        };
      },
    ),
    defineMcpTool(
      'save_sec_report',
      '将 fetch_sec_financials 的数据集写为当前工作区 report.md。数值、口径、同比、截至时间和 SEC 引用由代码自动生成。findings 仅传入基于工具结果的简短定性分析，不包含任何数字、虚构值、无证据因果或投资建议；缺失信息须说明。不要再用 write 重写此报告。',
      {
        dataset_id: z
          .string()
          .regex(
            /^\d{10}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
        findings: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(500)
              .refine(
                (s) => !/[0-9０-９]|\b(?:NaN|Infinity)\b/.test(s),
                '定性发现不得包含数值；指标表由代码生成',
              ),
          )
          .min(1)
          .max(6),
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
        const report = renderSecReport(
          JSON.parse(metrics) as FinancialDataset,
          findings,
        );
        const reportPath = path.join(directory, 'report.md');
        try {
          await fs.writeFile(reportPath, report, { flag: 'wx' });
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            (await fs.readFile(reportPath, 'utf8')) !== report
          )
            throw error;
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
                reportSha256: digest(report),
              }),
            },
          ],
        };
      },
    ),
  ];
}
