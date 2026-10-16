/**
 * 会话级「消息免打扰」的乐观更新与回滚。
 *
 * 点下去侧栏必须先切文案（否则要等一次 IPC 往返才更新），写库失败必须翻回来——
 * 留着一个没落库的「已静音」会让用户以为不会被打扰，实际照旧。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';

const m = vi.hoisted(() => ({ patchLocal: vi.fn(), patchMeta: vi.fn() }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { patchLocal: m.patchLocal } }));
vi.mock('@/lib/sessionService', () => ({ patchMeta: m.patchMeta }));

import { setSessionNotificationsMuted } from '../sessionNotificationMute';

const session = { id: 'task', title: 'Task' } as Session;

beforeEach(() => {
  vi.clearAllMocks();
  m.patchMeta.mockResolvedValue(session);
});

describe('setSessionNotificationsMuted', () => {
  it('flips the row before the write and persists the same value', async () => {
    await setSessionNotificationsMuted(session, true);

    expect(m.patchLocal).toHaveBeenCalledWith('task', { notificationsMuted: true });
    expect(m.patchMeta).toHaveBeenCalledWith('task', { notificationsMuted: true });
  });

  it('rolls the row back and rethrows when the write fails', async () => {
    m.patchMeta.mockRejectedValue(new Error('write failed'));

    await expect(
      setSessionNotificationsMuted({ ...session, notificationsMuted: true }, false),
    ).rejects.toThrow('write failed');

    expect(m.patchLocal).toHaveBeenCalledWith('task', { notificationsMuted: false });
    expect(m.patchLocal).toHaveBeenLastCalledWith('task', { notificationsMuted: true });
  });
});
