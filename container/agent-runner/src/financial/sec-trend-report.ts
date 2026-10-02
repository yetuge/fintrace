/** Charts and report are deterministic functions of structured metrics. */
import { comparableAnnual, type TrendDataset } from './sec-trends.js';
import type { Finding } from './sec-evidence.js';
const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );
const md = (s: string) => s.replace(/[|\r\n<>]/g, ' ');

export function buildTrendChartData(data: TrendDataset) {
  return {
    schemaVersion: 3,
    datasetId: data.datasetId,
    panels: data.metrics.flatMap((m) => {
      const currencies = [
        ...new Set(m.annual.flatMap((p) => (p.value ? [p.value.unit] : []))),
      ];
      return (currencies.length ? currencies : ['未知币种']).map((currency) => {
        const max = Math.max(
          0,
          ...m.annual.map((p) =>
            p.value?.unit === currency ? Math.abs(p.value.value) : 0,
          ),
        );
        const scale = max >= 1e9 ? 1e9 : max >= 1e6 ? 1e6 : 1;
        return {
          key: m.key,
          label: m.label,
          currency,
          scale,
          unit: `${currency}${scale === 1e9 ? ' 十亿' : scale === 1e6 ? ' 百万' : ' 基础单位'}`,
          points: m.annual.map((p, i) => ({
            end: p.end,
            evidenceId:
              p.value?.unit === currency
                ? `${data.datasetId}:${m.key}:${p.end}`
                : null,
            value: p.value?.unit === currency ? p.value.value : null,
            scaledValue:
              p.value?.unit === currency ? p.value.value / scale : null,
            connectPrevious:
              i > 0 &&
              p.value?.unit === currency &&
              !comparableAnnual(
                p.value,
                m.annual[i - 1].value,
                data.years[i],
                data.years[i - 1],
              ),
            missingReason:
              p.value?.unit === currency
                ? null
                : (p.missingReason ?? '本财年币种不同，单独绘制'),
          })),
        };
      });
    }),
  };
}
export function renderTrendSvg(
  chart: ReturnType<typeof buildTrendChartData>,
): string {
  const height = 80 + chart.panels.length * 240;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" role="img" aria-label="最近三个完整财年财务趋势">`,
    '<rect width="100%" height="100%" fill="#f5f6f3"/>',
    '<g font-family="Arial,Microsoft YaHei,sans-serif" fill="#14201d">',
    '<text x="40" y="32" font-size="22">年度财务趋势 · SEC 官方数据</text>',
    '<text x="40" y="58" font-size="13">各指标独立坐标轴；缺失不补零，口径变化不连接；金额方向不代表因果。</text>',
  ];
  chart.panels.forEach((panel, n) => {
    const top = 90 + n * 240;
    const values = panel.points.flatMap((p) =>
      p.scaledValue === null ? [] : [p.scaledValue],
    );
    const lo = Math.min(0, ...values),
      hi = Math.max(0, ...values);
    const span = hi - lo || 1;
    const y = (v: number) => top + 165 - ((v - lo) / span) * 125;
    const x = (i: number) =>
      panel.points.length <= 1
        ? 500
        : 180 + (i * 640) / (panel.points.length - 1);
    out.push(
      `<text x="40" y="${top}" font-size="18">${xml(panel.label)} · ${xml(panel.unit)}</text>`,
    );
    for (const v of [...new Set([lo, 0, hi])])
      out.push(
        `<line x1="150" y1="${y(v)}" x2="880" y2="${y(v)}" stroke="#b7c7c1"/><text x="140" y="${y(v) + 4}" text-anchor="end" font-size="12">${v.toFixed(2)}</text>`,
      );
    panel.points.forEach((p, i) => {
      out.push(
        `<text x="${x(i)}" y="${top + 195}" text-anchor="middle" font-size="13">${xml(p.end)}</text>`,
      );
      if (p.scaledValue === null) {
        out.push(
          `<text x="${x(i)}" y="${top + 105}" text-anchor="middle" font-size="14">缺失 / 币种不同</text>`,
        );
        return;
      }
      const previous = panel.points[i - 1];
      if (p.connectPrevious && previous?.scaledValue !== null && previous)
        out.push(
          `<line x1="${x(i - 1)}" y1="${y(previous.scaledValue!)}" x2="${x(i)}" y2="${y(p.scaledValue)}" stroke="#18766b" stroke-width="3"/>`,
        );
      out.push(
        `<circle cx="${x(i)}" cy="${y(p.scaledValue)}" r="5" fill="#18766b"><title>${xml(`${p.end}: ${p.value} ${panel.currency}; ${p.evidenceId}`)}</title></circle>`,
        `<text x="${x(i)}" y="${y(p.scaledValue) - 10}" text-anchor="middle" font-size="13">${p.scaledValue.toFixed(3)}</text>`,
      );
    });
    if (!panel.points.length)
      out.push(`<text x="180" y="${top + 100}">无可靠完整年度数据</text>`);
  });
  out.push('</g></svg>\n');
  return out.join('\n');
}
export function renderTrendReport(
  data: TrendDataset,
  findings: Finding[],
): string {
  const evidenceRef = (id: string) =>
    `[${id}](#evidence-${data.evidence.findIndex((e) => e.id === id) + 1})`;
  return [
    `# ${md(data.company.name)} 最近三个完整财年趋势分析`,
    '',
    `CIK：${data.company.cik}；股票代码：${data.company.tickers.map(md).join(', ')}；结构版本：3。`,
    '',
    `抓取时间：${data.fetchedAt}；申报筛选截至：${data.asOf}（UTC）。请求三个完整财年，实际可靠取得 ${data.years.length} 个。`,
    '',
    '历史值策略：latest_disclosed_as_of。统一采用截至研究日期最新年度披露的同期间值，包括修订申报与后续年度比较数；每个数值保留自身 filed 和 accession。这不是原始披露序列，也不保证未披露的重述已全部覆盖。',
    '',
    '## 财年期间',
    '',
    ...data.years.map(
      (y) =>
        `- ${y.start} 至 ${y.end}（${(Date.parse(y.end) - Date.parse(y.start)) / 86400000 + 1} 天）；余额为 ${y.end} 期末；[年度申报](${y.filing.url})。`,
    ),
    '',
    '## 三年指标与可比同比',
    '',
    `| 指标 | ${data.years.map((y) => `${y.end} 金额 / 同比`).join(' | ')} |`,
    `| --- | ${data.years.map(() => '---:').join(' | ')} |`,
    ...data.metrics.map(
      (m) =>
        `| ${m.label} | ${m.annual.map((p) => `${p.value ? `${p.value.value.toLocaleString('en-US')} ${p.value.unit} ${evidenceRef(`${data.datasetId}:${m.key}:${p.end}`)}` : '缺失'} / ${p.yoyPercent === null ? '未计算' : `${p.yoyPercent.toFixed(2)}%`}`).join(' | ')} |`,
    ),
    '',
    '金额使用 SEC 基础货币单位；同比由代码计算：(本年−上年)/上年×100%。最早展示年度没有更早基数。只有相邻且标签、币种、期间兼容时计算；上年为零或负数时不计算常规增长率，金额变化仍可陈述。',
    '',
    '## 趋势图',
    '',
    '[打开代码生成的趋势图](trends.svg)（同目录文件面板可预览）；[图表逐点数据](chart-data.json)。各指标及币种使用独立坐标轴，百万/十亿缩放由代码转换并注明，缺失不补零、不插值；不可比期间不连接。',
    '',
    '## 指标口径与缺失原因',
    '',
    ...data.metrics.flatMap((m) => [
      `- **${m.label}**：${m.basis}。`,
      ...m.annual.flatMap((p) => [
        ...(p.missingReason ? [`  - ${p.end} 缺失：${p.missingReason}。`] : []),
        ...(p.yoyReason ? [`  - ${p.end} 同比未计算：${p.yoyReason}。`] : []),
      ]),
    ]),
    '',
    '## 逐条发现',
    '',
    ...findings.flatMap((f, i) => [
      `### 发现 ${i + 1} · ${f.type === 'direct_fact' ? '直接事实（代码核验）' : '待验证判断'}`,
      '',
      md(f.content),
      '',
      `关联证据：${f.evidenceIds.map(evidenceRef).join('、') || '无可用指标证据'}。`,
      ...(f.requestedType !== f.type
        ? ['原始类型：分析解释；仅有指标，保守降为待验证判断。']
        : []),
      ...f.limitations.map((l) => `- 限制 / 尚缺：${md(l)}`),
      '',
    ]),
    '未读取申报正文。指标方向与连续变化不验证盈利质量、经营原因或偿债能力；引用存在、哈希一致和格式通过不等于语义或因果核验。',
    '',
    '## 指标证据目录',
    '',
    ...data.evidence.flatMap((e, i) => [
      `<a id="evidence-${i + 1}"></a>`,
      `- **${e.id}**：${e.label}；口径 ${e.basis}；${e.value.toLocaleString('en-US')} ${e.unit}；币种 ${e.currency}；${e.tag}；${e.start ? `${e.start} 至 ` : '期末 '}${e.end}；${e.form}；filed ${e.filed}；accession ${e.accession}；[SEC 官方出处](${e.source})。`,
    ]),
    '',
    '## 限制与数据完整性',
    '',
    ...data.warnings.map((w) => `- ${w}`),
    '',
    '本目录包含 raw.json、metrics.json、findings.json、manifest.json、chart-data.json、trends.svg 与 report.md。版本一、二历史产物保留原样，不原地升级。',
    '',
    '## SEC 官方来源',
    '',
    ...data.sources.map((s) => `- [SEC JSON](${s})`),
    '',
  ].join('\n');
}
