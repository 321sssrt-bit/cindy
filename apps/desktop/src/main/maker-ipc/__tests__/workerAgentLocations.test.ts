/**
 * 测试价值
 * - 生产入口与可观察结果：listWorkerAgentLocations() 列出同账号可执行电脑与 active 分享，不含本机
 * - Bug／规则依据：makecindy/cindy#7452 SC1，与 list_available_models 的 locations 同源
 * - 现有覆盖缺口：原实现是 register.ts 内部闭包，抽出后无行为测试
 * - 最小失败输入：本机/离线设备、paused 分享、设备列表抛错
 * - tier：unit
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

import { listWorkerAgentLocations } from '../workerAgentLocations.js';

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
});
