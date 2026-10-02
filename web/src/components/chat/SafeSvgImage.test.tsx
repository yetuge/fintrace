// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { SafeSvgImage, staticSvgImage } from './SafeSvgImage';

const drawing =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" role="img" aria-label="财务趋势"><rect width="100%" height="100%" fill="#f5f6f3"/><g font-family="Arial" fill="#14201d"><line x1="10" y1="50" x2="90" y2="50" stroke="#18766b" stroke-width="3"/><circle cx="20" cy="50" r="5" fill="#18766b"><title>年度金额：-3000000 USD</title></circle><text x="10" y="20" font-size="13" text-anchor="middle">-3.0 USD 百万</text></g></svg>';
afterEach(() => vi.unstubAllGlobals());
test('accepts static chart text including negative numbers and retains amount units', () => {
  expect(staticSvgImage(drawing)).toContain('-3.0 USD 百万');
  expect(staticSvgImage(drawing)).toContain('年度金额：-3000000 USD');
});
test.each([
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
  '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/image.png"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/paint)"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><text style="background:url(https://example.com)">a</text></svg>',
  '<!DOCTYPE svg [<!ENTITY x "value">]><svg xmlns="http://www.w3.org/2000/svg"/>',
  '<html><p>not an image</p></html>',
])(
  'rejects active markup, links, external resources and invalid image documents: %s',
  (input) => {
    expect(() => staticSvgImage(input)).toThrow();
  },
);
test('reads an authenticated attachment as a static image and releases its preview URL', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(drawing, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chart');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SafeSvgImage url="/api/chart" name="trends.svg" className="preview" />,
    );
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/chart',
    expect.objectContaining({ credentials: 'same-origin' }),
  );
  expect(container.querySelector('img')?.src).toBe('blob:chart');
  expect((create.mock.calls[0][0] as Blob).type).toBe('image/svg+xml');
  await act(async () => root.unmount());
  expect(revoke).toHaveBeenCalledWith('blob:chart');
  container.remove();
  vi.restoreAllMocks();
});
test('failed file loading shows an explicit error rather than a false loaded image', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('denied', { status: 403 })),
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SafeSvgImage url="/api/missing" name="trends.svg" className="preview" />,
    );
  });
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    '读取失败',
  );
  expect(container.querySelector('img')).toBeNull();
  await act(async () => root.unmount());
  container.remove();
});
