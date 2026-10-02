/** Optional provenance for explicit evaluation inputs. Historical product datasets stay unchanged. */
export interface SecDataContext {
  mode: 'live_sec' | 'snapshot' | 'injected_failure';
  inputVersion: string;
  inputSha256: string;
  source: string;
  injection?: string;
}
export function withDataContext<T extends object>(
  dataset: T,
  context?: SecDataContext,
): T & { dataContext?: SecDataContext } {
  return context ? { ...dataset, dataContext: context } : dataset;
}
export function dataContextBanner(context?: SecDataContext): string {
  if (!context) return '';
  return `> 数据模式：${context.mode}；输入版本：${context.inputVersion}；输入 SHA-256：${context.inputSha256}。${context.mode === 'live_sec' ? '本次真实在线 SEC 获取。' : '本次没有在线获取成功：固定公开 SEC 片段' + (context.injection ? `，人为注入 ${context.injection}` : '') + '。'}\n\n`;
}
