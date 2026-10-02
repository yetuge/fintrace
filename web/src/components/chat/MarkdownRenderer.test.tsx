// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';
vi.mock('./MermaidDiagram', () => ({ MermaidDiagram: () => null }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: { host: HTMLDivElement; root: Root }[] = [];
afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});
async function render(content: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  await act(async () =>
    root.render(
      React.createElement(MarkdownRenderer, { content, variant: 'docs' }),
    ),
  );
  return host;
}
const report =
  '[当前研究证据](#evidence-1)\n\n<a id="evidence-1"></a>\n\n营收；USD；filed；accession。';
test('evidence links scroll to their sanitized target in the current report', async () => {
  const other = await render(report),
    host = await render(report);
  const wrong = vi.fn(),
    correct = vi.fn();
  other.querySelector<HTMLElement>('#user-content-evidence-1')!.scrollIntoView =
    wrong;
  host.querySelector<HTMLElement>('#user-content-evidence-1')!.scrollIntoView =
    correct;
  const link = host.querySelector<HTMLAnchorElement>('a[href="#evidence-1"]')!;
  expect(link.target).toBe('');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    link.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(correct).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
  expect(wrong).not.toHaveBeenCalled();
});
test('missing or malformed fragments stay in the preview and do not navigate away', async () => {
  const host = await render('[缺失](#missing) [无效](#%ZZ)');
  for (const link of host.querySelectorAll('a')) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  }
});
test('official external sources retain safe external navigation and HTML remains sanitized', async () => {
  const host = await render(
    '[SEC](https://www.sec.gov/Archives/)\n\n<a id="evidence-1" onclick="alert(1)"></a><script>alert(1)</script>',
  );
  const source = host.querySelector<HTMLAnchorElement>(
    'a[href="https://www.sec.gov/Archives/"]',
  )!;
  expect(source.target).toBe('_blank');
  expect(source.rel).toBe('noopener noreferrer');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    source.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector('[onclick]')).toBeNull();
  expect(host.querySelector('#user-content-evidence-1')).not.toBeNull();
});
