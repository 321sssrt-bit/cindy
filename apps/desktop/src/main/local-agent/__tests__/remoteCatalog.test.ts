/** Unit: production directory reader with device-link responses, no accounts or network.
 * Protects the missing remote/share choices, model access and account-switch fence. */
import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ devices: [] as unknown[], shares: [] as unknown[], invoke: vi.fn(), api: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ deviceLinkApiBase: 'https://example.invalid', remoteBackgroundInvoke: mock.invoke }));
vi.mock('../../device-link/providerShareGuest.js', () => ({ getReceivedShares: () => mock.shares }));
vi.mock('../../device-link/settings-store.js', () => ({ readDeviceLinkSettings: () => ({ disabledControlDeviceIds: ['disabled'], lastKnownDeviceNames: {} }) }));
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: mock.api }));
vi.mock('../../i18n.js', () => ({ t: () => '来自 {{name}} 的分享' }));
import { remoteLocalAgentModels } from '../remoteCatalog.js';
import { LOCAL_AGENT_ROUTE } from '../catalog.js';

const provider = { id: 'openai', name: 'OpenAI', source: 'user', connected: true, agents: ['pi', 'codex'],
  remoteInvocationEnabled: true, models: { pi: [{ id: 'm', name: 'M', efforts: [] }], codex: [{ id: 'm', name: 'M', efforts: [] }] } };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); mock.devices = []; mock.shares = []; });
function setup() {
  mock.devices = ['self', 'device', 'disabled', 'offline'].map(deviceId => ({ deviceId, name: deviceId, isSelf: deviceId === 'self', online: deviceId !== 'offline', remoteControlEnabled: true }));
  mock.shares = ['active', 'paused'].map(status => ({ status, shareId: status, providerId: 'openai', owner: { displayName: 'LiZi' } }));
  mock.api.mockImplementation(async () => ({ devices: mock.devices }));
  mock.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: channel === 'maker:list-available-agents' ? ['pi'] : { providers: [provider, { ...provider, id: 'private', remoteInvocationEnabled: false }] } }));
}
describe('application remote catalog', () => {
  it('uses remote runtime availability and keeps device/share identities and source names', async () => {
    setup();
    const models = await remoteLocalAgentModels(() => true);
    expect(models.map(m => m.providerLabel)).toEqual(['OpenAI · device', 'OpenAI · 来自 LiZi 的分享']);
    expect(models.map(m => m[LOCAL_AGENT_ROUTE])).toEqual([{ deviceId: 'device', providerId: 'openai' }, { deviceId: 'share:active', providerId: 'openai' }]);
    expect(models.every(m => m.engine === 'pi')).toBe(true);
    expect(new Set(mock.invoke.mock.calls.map(args => args[0]))).toEqual(new Set(['device', 'share:active']));
  });
  it('drops one unavailable peer without dropping healthy suppliers', async () => {
    setup();
    const invoke = mock.invoke.getMockImplementation()!;
    mock.invoke.mockImplementation((device, ...args) => device === 'device' ? Promise.reject(new Error('offline')) : invoke(device, ...args));
    expect((await remoteLocalAgentModels(() => true)).map(m => m.providerLabel)).toEqual(['OpenAI · 来自 LiZi 的分享']);
  });
  it('discards a directory response after an account change before contacting its peers', async () => {
    setup();
    expect(await remoteLocalAgentModels(() => false)).toEqual([]);
    expect(mock.invoke).not.toHaveBeenCalled();
  });
  it('bounds a sleeping peer without real-time sleeps', async () => {
    setup(); vi.useFakeTimers();
    mock.invoke.mockImplementation(() => new Promise(() => {}));
    const reading = remoteLocalAgentModels(() => true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await reading).toEqual([]);
  });
});
