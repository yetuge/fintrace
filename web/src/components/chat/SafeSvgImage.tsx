import { useEffect, useState } from 'react';

/** A static drawing subset rendered as an image, never inserted as active page markup.
 * Keep the server's attachment/no-sniff policy for arbitrary SVG files unchanged. */
export function staticSvgImage(text: string): string {
  if (text.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error('不支持的 SVG 文档');
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  const tags = new Set(['svg', 'g', 'rect', 'line', 'circle', 'text', 'title']);
  const attributes = new Set([
    'xmlns',
    'width',
    'height',
    'viewBox',
    'role',
    'aria-label',
    'font-family',
    'fill',
    'x',
    'y',
    'font-size',
    'text-anchor',
    'stroke',
    'stroke-width',
    'x1',
    'x2',
    'y1',
    'y2',
    'cx',
    'cy',
    'r',
  ]);
  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  if (
    root.localName !== 'svg' ||
    elements.length > 20_000 ||
    elements.some(
      (e) =>
        e.namespaceURI !== 'http://www.w3.org/2000/svg' ||
        !tags.has(e.localName),
    )
  )
    throw new Error('安全预览仅支持静态基本 SVG 绘图');
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (
        !attributes.has(attribute.name) ||
        (attribute.name === 'xmlns' &&
          attribute.value !== 'http://www.w3.org/2000/svg') ||
        (['fill', 'stroke'].includes(attribute.name) &&
          !/^(#[a-f\d]{3,8}|none|transparent|currentColor)$/i.test(
            attribute.value,
          ))
      )
        throw new Error('SVG 包含不支持的属性或外部资源');
    }
  }
  return new XMLSerializer().serializeToString(root);
}

export function SafeSvgImage({
  url,
  name,
  className,
}: {
  url: string;
  name: string;
  className: string;
}) {
  const [result, setResult] = useState<{
    url: string;
    src?: string;
    error?: string;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      try {
        const response = await fetch(url, {
          signal: abort.signal,
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('图表文件读取失败');
        const drawing = staticSvgImage(await response.text());
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(
          new Blob([drawing], { type: 'image/svg+xml' }),
        );
        setResult({ url, src: objectUrl });
      } catch (error) {
        if (!abort.signal.aborted)
          setResult({
            url,
            error: error instanceof Error ? error.message : '图表预览失败',
          });
      }
    })();
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  if (result?.url !== url)
    return (
      <p className="text-white p-8" role="status">
        正在读取图表…
      </p>
    );
  if (result.error)
    return (
      <p className="text-white p-8" role="alert">
        {result.error}；可下载原文件检查。
      </p>
    );
  return (
    <img
      src={result.src}
      alt={name}
      className={className}
      onError={() => setResult({ url, error: '图表无法显示' })}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
