/**
 * useSessionBrowseHistory —— 把当前任务视图记进浏览栈,并接上后退/前进。
 *
 * 快捷键与按钮共用同一份栈(cc-agent/sessionBrowseHistory);`history` 参数只
 * 为测试注入独立实例,生产调用不传,直接用窗口内唯一的单例。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAppShortcut } from '@/hooks/useAppShortcut';
import {
  sessionBrowseHistory,
  sessionIdFromPathname,
  type SessionBrowseHistory,
} from './sessionBrowseHistory';

export interface SessionBrowseNavigation {
  canBack: boolean;
  canForward: boolean;
  goBack: () => boolean;
  goForward: () => boolean;
}

export function useSessionBrowseHistory(
  history: SessionBrowseHistory = sessionBrowseHistory,
): SessionBrowseNavigation {
  const location = useLocation();
  const navigate = useNavigate();
  const { ids, index } = useSyncExternalStore(history.subscribe, history.snapshot);
  const sessionId = sessionIdFromPathname(location.pathname);

  useEffect(() => {
    if (sessionId) history.record(sessionId);
  }, [history, sessionId]);

  const go = useCallback(
    (direction: -1 | 1) => {
      const target = history.step(direction);
      if (!target) return false;
      navigate(`/cc-agent/${target}`);
      return true;
    },
    [history, navigate],
  );
  const goBack = useCallback(() => go(-1), [go]);
  const goForward = useCallback(() => go(1), [go]);

  // Windows / Linux 上 mod+[ 在终端里是 ESC（vim / readline）：焦点在终端时让给 PTY，
  // 不做窗口级导航。mac 的 ⌘[ 在终端无原生含义，同一道门一并让路无副作用。
  const outsideTerminal = (event: KeyboardEvent) =>
    !(event.target instanceof Element && event.target.closest('.xterm'));

  useAppShortcut('session-history-back', (event) => outsideTerminal(event) && goBack());
  useAppShortcut('session-history-forward', (event) => outsideTerminal(event) && goForward());

  return {
    canBack: index > 0,
    canForward: index >= 0 && index < ids.length - 1,
    goBack,
    goForward,
  };
}
