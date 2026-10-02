import type { Score, Trace } from './types.js';
import { dimensions } from './score.js';
export function usageTotals(traces: Trace[]) {
  const sum = (field: 'modelRequests' | 'elapsedMs') => ({
    known: traces.reduce(
      (total, t) =>
        total + (typeof t[field] === 'number' ? (t[field] as number) : 0),
      0,
    ),
    unavailableTasks: traces.filter(
      (t) => t.status === 'executed' && t[field] === 'unavailable',
    ).length,
  });
  return {
    requests: sum('modelRequests'),
    elapsedMs: sum('elapsedMs'),
    outputTokens: {
      known: traces.reduce(
        (total, t) =>
          total +
          (typeof t.usage.output === 'number'
            ? t.usage.output
            : (t.knownUsage?.output ?? 0)),
        0,
      ),
      unavailableTasks: traces.filter(
        (t) => t.status === 'executed' && t.usage.output === 'unavailable',
      ).length,
    },
    cost: 'unavailable',
  };
}
export function summarize(scores: Score[]) {
  return Object.fromEntries(
    ['all', 'live_sec', 'snapshot', 'injected_failure'].map((mode) => {
      const tasks = scores.filter((s) => mode === 'all' || s.mode === mode);
      return [
        mode,
        {
          executed: tasks.filter((s) => s.execution === 'executed').length,
          notExecuted: tasks.filter((s) => s.execution === 'not_executed')
            .length,
          dimensions: Object.fromEntries(
            dimensions.map((d) => {
              const applicable = tasks.filter(
                (s) =>
                  s.execution === 'executed' &&
                  s.dimensions[d].status !== 'not_applicable',
              );
              const count = (status: string) =>
                applicable.filter((s) => s.dimensions[d].status === status)
                  .length;
              return [
                d,
                {
                  denominator: applicable.length,
                  passed: count('passed'),
                  failed: count('failed'),
                  needsReview: count('needs_review'),
                },
              ];
            }),
          ),
        },
      ];
    }),
  );
}
export function markdownReport(
  metadata: Record<string, unknown>,
  traces: Trace[],
  scores: Score[],
) {
  const lines = [
    '# FinTrace 最小 Agent Benchmark',
    '',
    `元数据：\`${JSON.stringify(metadata)}\``,
    `本批可得用量汇总：\`${JSON.stringify(usageTotals(traces))}\`。未知部分不估算；跨批预算预留见元数据及 budget.json。`,
    '',
    '评价 Agent 行为与任务结果；单元测试数量不是成绩。仅代表本次六项小样本，不推出普遍成功率或模型/框架优越性。',
    '',
    '模型请求数为 Pi stream 边界调用次数（包括错误尝试）；关闭 SDK 与会话自动重试。输出预算在请求前预留，已知用量释放差额；未知用量保留额度。Provider 是否遵守 max_tokens 仍取决于上游服务；费用 unavailable，不估算。',
    '',
    '| Task | Mode | Execution | Outcome | Requests | Output tokens | Elapsed ms |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
    ...scores.map(
      (s, i) =>
        `| ${s.taskId} | ${s.mode} | ${s.execution} | ${s.overall} | ${traces[i].modelRequests} | ${traces[i].usage.output} | ${traces[i].elapsedMs} |`,
    ),
    '',
    '## 分母与模式分别统计',
    '',
    '```json',
    JSON.stringify(summarize(scores), null, 2),
    '```',
    '',
  ];
  for (const s of scores) {
    lines.push(
      `## ${s.taskId}`,
      '',
      ...dimensions.flatMap((d) => [
        `- **${d}**: ${s.dimensions[d].status}。${s.dimensions[d].evidence.join(' ')}`,
        `  能力边界：${s.dimensions[d].boundary}`,
      ]),
      '',
      ...s.attribution.map((a) => `- 归因：${a}`),
      '',
      '人工复核：',
      ...s.review.map((r) => `- [ ] ${r}`),
      '',
    );
  }
  lines.push(
    '## 入口与局限',
    '',
    '使用产品 PiRuntimeAdapter、同一 Provider 解析和 SEC→Pi 工具适配路径；隔离任务仅开放金融工具，停用插件、记忆、项目上下文、自动压缩与自动重试。这是受控工具范围的真实 Agent 执行，不等同完整工作台端到端验证。没有预写回复、假模型或 LLM judge。',
    '',
    '本批次没有经正常登录的工作台发送模型任务；已有工作台验证不能追认到本批次。以 CLI 执行便于严格在请求边界共享预算，未修改正常会话和认证。',
    '',
    '数值重算依赖本次原始输入。哈希、有效关联、代码分类、结构化自述均不证明自然语言或因果结论成立。最终回答与解释、偿债能力、缺失/失败说明需人工复核；未读取申报正文。故障注入不代表在线 SEC 出现故障。',
    '',
    '全仓历史失败保留；必要确定性检查通过不等于全仓通过。每项失败保留原始 trace，重新评分不会发出模型请求。',
    '',
  );
  return lines.join('\n');
}
