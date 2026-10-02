// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { SessionSidebar } from './SessionSidebar';
import type { AgentInfo } from '../../types';

// Layout is unavailable in happy-dom; render the virtual window's rows.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 48,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 48,
      })),
  }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: { host: HTMLDivElement; root: Root }[] = [];
afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.clearAllMocks();
});
function session(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    name: `研究 ${id}`,
    prompt: '',
    status: 'completed',
    kind: 'conversation',
    created_at: '2026-10-02T00:00:00Z',
    ...overrides,
  };
}
type Props = React.ComponentProps<typeof SessionSidebar>;
async function render(overrides: Partial<Props> = {}) {
  const props: Props = {
    sessions: [session('a'), session('b')],
    activeSessionId: 'a',
    canModify: true,
    onSelectSession: vi.fn(),
    onDeleteSession: vi.fn(async () => true),
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  const update = async (changes: Partial<Props>) => {
    Object.assign(props, changes);
    await act(async () =>
      root.render(React.createElement(SessionSidebar, props)),
    );
  };
  await update({});
  return { host, props, update };
}
function button(text: string, scope: ParentNode = document) {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) =>
      item.getAttribute('aria-label') === text || item.textContent === text,
  );
  expect(element, `button ${text}`).toBeDefined();
  return element!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

test('independent delete opens confirmation without selecting or deleting the session; cancel keeps it', async () => {
  const { host, props } = await render();
  expect(host.querySelector('button[aria-label^="删除会话："]')).toBeNull();
  await openDelete(host, 'b');
  expect(props.onSelectSession).not.toHaveBeenCalled();
  expect(props.onDeleteSession).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain('“研究 b”');
  expect(dialog.textContent).toContain(
    '工作区文件（包括研究报告）和其他会话会保留',
  );
  await click(button('取消', dialog));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(props.onDeleteSession).not.toHaveBeenCalled();
  expect(button('研究 b的更多操作', host)).toBeDefined();
});

test('confirmation deletes only the chosen session and closes on success', async () => {
  const { host, props } = await render();
  await openDelete(host, 'b');
  await click(
    button('删除会话', document.querySelector('[role="alertdialog"]')!),
  );
  expect(props.onDeleteSession).toHaveBeenCalledExactlyOnceWith('b');
  expect(props.onSelectSession).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

test('pending deletion blocks repeat submission and cancellation, including Escape', async () => {
  let resolve!: (value: boolean) => void;
  const onDeleteSession = vi.fn(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const { host } = await render({ onDeleteSession });
  await openDelete(host, 'a');
  const dialog = document.querySelector('[role="alertdialog"]')!;
  await click(button('删除会话', dialog));
  expect(button('删除会话', dialog).disabled).toBe(true);
  expect(button('取消', dialog).disabled).toBe(true);
  await click(button('删除会话', dialog));
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(onDeleteSession).toHaveBeenCalledTimes(1);
  await act(async () => resolve(true));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

test('a rejected deletion keeps confirmation and session available for retry', async () => {
  const onDeleteSession = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const { host } = await render({ onDeleteSession });
  await openDelete(host, 'a');
  await click(
    button('删除会话', document.querySelector('[role="alertdialog"]')!),
  );
  expect(
    button('删除会话', document.querySelector('[role="alertdialog"]')!)
      .disabled,
  ).toBe(false);
  expect(button('研究 a的更多操作', host)).toBeDefined();
  await click(
    button('删除会话', document.querySelector('[role="alertdialog"]')!),
  );
  expect(onDeleteSession.mock.calls).toEqual([['a'], ['a']]);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

test('channel-managed sessions remain protected; readonly users have no mutation menu', async () => {
  const { host, update } = await render({
    sessions: [
      session('main'),
      session('a'),
      session('native', { source_kind: 'native_thread' }),
      session('legacy', { title_source: 'feishu_root' }),
    ],
  });
  const entries = () =>
    [...host.querySelectorAll('button[aria-label$="的更多操作"]')].map((item) =>
      item.getAttribute('aria-label'),
    );
  expect(entries()).toEqual(['研究 main的更多操作', '研究 a的更多操作']);
  await update({ canModify: false });
  expect(entries()).toEqual([]);
});

test('permission loss or removal after opening prevents deletion of a stale target', async () => {
  const { host, props, update } = await render();
  await openDelete(host, 'a');
  await update({ canModify: false });
  expect(
    button('删除会话', document.querySelector('[role="alertdialog"]')!)
      .disabled,
  ).toBe(true);
  await update({ canModify: true, sessions: [session('b')] });
  expect(
    button('删除会话', document.querySelector('[role="alertdialog"]')!)
      .disabled,
  ).toBe(true);
  await click(
    button('删除会话', document.querySelector('[role="alertdialog"]')!),
  );
  expect(props.onDeleteSession).not.toHaveBeenCalled();
});

async function openDelete(host: HTMLElement, id: string) {
  const trigger = button('研究 ' + id + '的更多操作', host);
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse',
      }),
    );
  });
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((entry) => entry.textContent === '删除');
  expect(item).toBeDefined();
  await click(item!);
}
test('the former main session uses the same confirmed deletion as other sessions', async () => {
  const { host, props } = await render({
    sessions: [session('main')],
    activeSessionId: 'main',
  });
  await openDelete(host, 'main');
  await click(
    button('删除会话', document.querySelector('[role="alertdialog"]')!),
  );
  expect(props.onDeleteSession).toHaveBeenCalledExactlyOnceWith('main');
});
test('an empty workspace contains no implicit conversation or mutation menu', async () => {
  const { host } = await render({ sessions: [], activeSessionId: null });
  expect(host.textContent).toContain('暂无会话，发送消息即可开始新对话');
  expect(host.querySelector('button[aria-current]')).toBeNull();
  expect(host.querySelector('button[aria-label$="的更多操作"]')).toBeNull();
});

test('legacy and isolated sessions keep their correct binding targets in the same menu', async () => {
  const onBindSession = vi.fn();
  const { host } = await render({
    sessions: [session('main'), session('a')],
    onBindSession,
  });
  for (const id of ['main', 'a']) {
    const trigger = button(`研究 ${id}的更多操作`, host);
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        }),
      );
    });
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((entry) => entry.textContent === '会话绑定');
    await click(item!);
  }
  expect(onBindSession.mock.calls).toEqual([[null], ['a']]);
});
