/**
 * agentIslandSessionPatch —— sessions patch 里灵动岛关心字段的转发口径。
 *
 * 「消息免打扰」不只是「后面的事件别进岛」：任务可能已经上岛了，只挡后续事件会让
 * 卡片永远停在「运行中」。所以开静音和转入后台一样，要把这个任务从岛上收走。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handleSessionClosed: vi.fn(),
  handleSessionMetadataPatch: vi.fn(),
  getAgentIslandService: vi.fn(),
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: h.getAgentIslandService,
}));

import { notifyAgentIslandSessionPatch } from '../agentIslandSessionPatch';

async function notify(patch: Record<string, unknown>): Promise<void> {
  notifyAgentIslandSessionPatch('session-1', patch);
  // 模块用动态 import 解耦，断言前把微任务队列排空。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getAgentIslandService.mockReturnValue({
    handleSessionClosed: h.handleSessionClosed,
    handleSessionMetadataPatch: h.handleSessionMetadataPatch,
  });
});

describe('notifyAgentIslandSessionPatch', () => {
  it('pulls a task off the island when a mute is turned on', async () => {
    await notify({ notificationsMuted: true });

    expect(h.handleSessionClosed).toHaveBeenCalledWith('session-1');
  });

  it('leaves the island alone when a mute is turned off', async () => {
    await notify({ notificationsMuted: false });

    expect(h.handleSessionClosed).not.toHaveBeenCalled();
    expect(h.handleSessionMetadataPatch).not.toHaveBeenCalled();
  });

  it('still forwards metadata patches', async () => {
    await notify({ title: 'Renamed' });

    expect(h.handleSessionClosed).not.toHaveBeenCalled();
    expect(h.handleSessionMetadataPatch).toHaveBeenCalledWith('session-1', {
      title: 'Renamed',
      workingDir: undefined,
      workspaceKind: undefined,
    });
  });
});
