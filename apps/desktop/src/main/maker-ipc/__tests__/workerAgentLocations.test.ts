/**
 * 测试价值
 * - 生产入口与可观察结果：插件模型缓存使用真实 readWorkerAgentLocations；完整读取后显示远程电脑，失败时省略 locations，恢复后可重读
 * - Bug／规则依据：makecindy/cindy#7452 SC1；makecindy/cindy#7472 Greptile 失败位置缓存；plugin-agent-models.md §4.0.3a
 * - 现有覆盖缺口：现有用例只验证读取函数的降级列表，没有验证插件缓存不会保存该降级结果
 * - 最小失败输入：handleListDevices 首次拒绝、随后返回一台远程电脑；同时有一个 active 分享
 * - tier：unit
 * - 实测耗时：4.70 s（修复后单文件运行，macOS arm64）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';

const io = vi.hoisted(() => ({
  handleListDevices: vi.fn(),
  getReceivedShares: vi.fn(() => [] as Array<{
    shareId: string;
    status: 'active' | 'paused';
    providerLabel: string;
    owner: { displayName: string };
  }>),
  providerShareAgentDeviceId: vi.fn((id: string) => `share:${id}`),
}));

vi.mock('../../device-link/ipc.js', () => ({
  handleListDevices: io.handleListDevices,
  defaultDeps: vi.fn(() => ({})),
}));
vi.mock('../../device-link/providerShareGuest.js', () => ({
  getReceivedShares: io.getReceivedShares,
  providerShareAgentDeviceId: io.providerShareAgentDeviceId,
}));

import { listWorkerAgentLocations, readWorkerAgentLocations } from '../workerAgentLocations.js';
import { createGhostAgentModelsCache } from '../../cindy-brain/ghostAgentModels.js';

function device(overrides: Partial<DeviceLinkDeviceView>): DeviceLinkDeviceView {
  return {
    deviceId: 'mac-mini',
    name: 'Mac mini',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...overrides,
  };
}

describe('listWorkerAgentLocations', () => {
  beforeEach(() => {
    io.handleListDevices.mockReset();
    io.getReceivedShares.mockReset();
    io.providerShareAgentDeviceId.mockClear();
    io.handleListDevices.mockResolvedValue({ devices: [] });
    io.getReceivedShares.mockReturnValue([]);
  });

  it('lists online remote-control computers and active shares, excluding this computer', async () => {
    io.handleListDevices.mockResolvedValue({
      devices: [
        device({}),
        device({ deviceId: 'self', name: 'This Mac', isSelf: true }),
        device({ deviceId: 'offline', name: 'Offline', online: false }),
        device({ deviceId: 'phone', name: 'iPhone', platform: 'ios' }),
      ],
    });
    io.getReceivedShares.mockReturnValue([
      { shareId: 's1', status: 'active', providerLabel: 'Claude API', owner: { displayName: 'Ann' } },
      { shareId: 's2', status: 'paused', providerLabel: 'Paused', owner: { displayName: 'Bob' } },
    ]);
    await expect(listWorkerAgentLocations()).resolves.toEqual([
      { agentDeviceId: 'mac-mini', name: 'Mac mini' },
      { agentDeviceId: 'share:s1', name: 'Claude API · Ann' },
    ]);
  });

  it('omits computers when the device list fails and still returns active shares', async () => {
    io.handleListDevices.mockRejectedValue(new Error('cloud down'));
    io.getReceivedShares.mockReturnValue([
      { shareId: 's1', status: 'active', providerLabel: 'Claude API', owner: { displayName: 'Ann' } },
    ]);
    await expect(listWorkerAgentLocations()).resolves.toEqual([
      { agentDeviceId: 'share:s1', name: 'Claude API · Ann' },
    ]);
  });

  it('does not cache fallback locations after a failed device read and recovers on retry', async () => {
    const cache = createGhostAgentModelsCache();
    io.handleListDevices
      .mockRejectedValueOnce(new Error('cloud down'))
      .mockResolvedValueOnce({ devices: [device({})] });
    io.getReceivedShares.mockReturnValue([
      { shareId: 's1', status: 'active', providerLabel: 'Claude API', owner: { displayName: 'Ann' } },
    ]);

    await expect(cache.locations('owner', readWorkerAgentLocations)).resolves.toBeUndefined();
    await expect(cache.locations('owner', readWorkerAgentLocations)).resolves.toEqual([
      { agentDeviceId: 'mac-mini', name: 'Mac mini' },
      { agentDeviceId: 'share:s1', name: 'Claude API · Ann' },
    ]);
    expect(io.handleListDevices).toHaveBeenCalledTimes(2);
  });
});
