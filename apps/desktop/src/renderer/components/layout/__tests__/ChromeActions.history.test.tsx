// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:真实 hook(useSessionBrowseHistory)+ 真实按钮簇
 *   (SessionHistoryButtons)。可观察结果是按钮的可用/置灰态、tooltip 文案、
 *   点击与 ⌘[ / ⌘] 之后路由落在哪个任务。
 * - Bug / 规则依据:新功能「任务浏览栈」—— 没有上一个/下一个任务时置灰并说明
 *   原因(DESIGN §14.6),后退/前进按浏览器语义走栈,快捷键与按钮同一份栈。
 * - 现有覆盖缺口:新组件。
 * - 最小失败输入:在 /cc-agent/a 渲染后断言后退可用(应为否);或点后退后
 *   URL 没回到上一个任务。
 * - tier:unit(jsdom,MemoryRouter + 真实 registry 组合键)。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/title-bar/MenuButton', () => ({ MenuButton: () => null }));

import { SessionHistoryButtons } from '@/components/layout/ChromeActions';
import {
  formatAppShortcutCombo,
  getEffectiveAppShortcuts,
  type AppShortcutId,
} from '../../../../shared/appShortcuts';
import { createSessionBrowseHistory } from '@/features/cc-agent/sessionBrowseHistory';
import { useSessionBrowseHistory } from '@/features/cc-agent/useSessionBrowseHistory';
import { getAppShortcutPlatform } from '@/lib/appShortcutStore';

afterEach(cleanup);

function PathLabel(): React.ReactElement {
  const { pathname } = useLocation();
  return <span data-testid="path">{pathname}</span>;
}

function OpenTask({ id }: { id: string }): React.ReactElement {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/cc-agent/${id}`)}>{`open ${id}`}</button>;
}

function Harness({ history }: { history: ReturnType<typeof createSessionBrowseHistory> }): React.ReactElement {
  return (
    <>
      <SessionHistoryButtons {...useSessionBrowseHistory(history)} />
      <PathLabel />
      <OpenTask id="b" />
      <OpenTask id="c" />
    </>
  );
}

function renderAt(pathname: string) {
  const history = createSessionBrowseHistory();
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Harness history={history} />
    </MemoryRouter>,
  );
  return history;
}

function defaultCombo(id: AppShortcutId) {
  const platform = getAppShortcutPlatform();
  const combo = getEffectiveAppShortcuts({}, platform).get(id)?.[0];
  if (!combo) throw new Error(`no default combo for ${id}`);
  return { platform, combo };
}

function press(combo: { code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }) {
  fireEvent.keyDown(window, {
    code: combo.code,
    metaKey: combo.meta,
    ctrlKey: combo.ctrl,
    altKey: combo.alt,
    shiftKey: combo.shift,
  });
}

describe('SessionHistoryButtons', () => {
  it('greys both directions out on the first task and says why', () => {
    renderAt('/cc-agent/a');

    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a');
    expect(
      (screen.getByRole('button', { name: 'titleBar.historyBackUnavailable' }) as HTMLElement).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      (screen.getByRole('button', { name: 'titleBar.historyForwardUnavailable' }) as HTMLElement).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('walks back to the previous task and forward again, state following the stack', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');

    await user.click(screen.getByRole('button', { name: 'open b' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    const back = screen.getByRole('button', { name: 'titleBar.historyBack' });
    expect(back.hasAttribute('disabled')).toBe(false);

    await user.click(back);
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a');
    expect(screen.getByRole('button', { name: 'titleBar.historyBackUnavailable' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'titleBar.historyForward' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');
    expect(screen.getByRole('button', { name: 'titleBar.historyForwardUnavailable' })).toBeTruthy();
  });

  it('drops the forward side when a different task opens after going back', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');

    await user.click(screen.getByRole('button', { name: 'open b' }));
    await user.click(screen.getByRole('button', { name: 'open c' }));
    await user.click(screen.getByRole('button', { name: 'titleBar.historyBack' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    await user.click(screen.getByRole('button', { name: 'open c' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/c');
    expect(screen.getByRole('button', { name: 'titleBar.historyForwardUnavailable' })).toBeTruthy();
  });

  it('names the shortcut in the tooltip', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');
    await user.click(screen.getByRole('button', { name: 'open b' }));

    const { platform, combo } = defaultCombo('session-history-back');
    await user.hover(screen.getByRole('button', { name: 'titleBar.historyBack' }));

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      `titleBar.historyBack (${formatAppShortcutCombo(combo, platform)})`,
    );
  });

  it('walks the same stack from the keyboard shortcut', async () => {
    renderAt('/cc-agent/a');
    fireEvent.click(screen.getByRole('button', { name: 'open b' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    press(defaultCombo('session-history-back').combo);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a'));

    press(defaultCombo('session-history-forward').combo);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b'));
  });
});
