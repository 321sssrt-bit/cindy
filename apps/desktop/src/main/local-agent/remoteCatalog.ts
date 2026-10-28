/** The same authorized device/share directory used by Cindy's model picker. */
import type { AgentKind } from '@cindy/maker-core';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { deviceLinkApiBase, remoteBackgroundInvoke } from '../device-link/index.js';
import { getReceivedShares } from '../device-link/providerShareGuest.js';
import { readDeviceLinkSettings } from '../device-link/settings-store.js';
import { serverApiFetch } from '../serverApiClient.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { t } from '../i18n.js';
import { localAgentModels, type LocalAgentModel } from './catalog.js';

export interface RemoteCatalogSource { deviceId: string; label: string; providerId?: string }

// A sleeping/offline peer must not prevent using a local supplier. No cache: open
// re-reads the same directory, and the remote host enforces live authorization.
async function bounded<T>(read: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), 3000); })]);
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}

export async function readRemoteCatalog(
  sources: readonly RemoteCatalogSource[],
  invoke: typeof remoteBackgroundInvoke = remoteBackgroundInvoke,
): Promise<LocalAgentModel[]> {
  const lists = await Promise.all(sources.map(async source => {
    try {
      const [catalog, available] = await Promise.all([
        bounded(readDeviceProviderViews(invoke, source.deviceId, { visibleOnly: true }), []),
        bounded(invoke(source.deviceId, 'maker:list-available-agents', []), { ok: false, error: { code: 'IPC_ERROR', message: 'Catalog unavailable' } }),
      ]);
      if (!available.ok || !Array.isArray(available.result)) return [];
      const engines = available.result.filter((kind): kind is AgentKind => kind === 'pi' || kind === 'codex' || kind === 'claude-code');
      return localAgentModels(catalog.filter(provider => !source.providerId || provider.id === source.providerId), engines, source);
    } catch { return []; }
  }));
  return lists.flat();
}

export async function remoteLocalAgentModels(isCurrent: () => boolean): Promise<LocalAgentModel[]> {
  const settings = readDeviceLinkSettings();
  const shares = getReceivedShares().filter(share => share.status === 'active');
  const directory = await bounded(serverApiFetch<{ devices: DeviceLinkDeviceView[] }>('/api/device-link/devices', { baseUrl: deviceLinkApiBase }), { devices: [] });
  if (!isCurrent()) return [];
  const sources: RemoteCatalogSource[] = directory.devices
    .filter(device => !device.isSelf && device.online && device.remoteControlEnabled && !settings.disabledControlDeviceIds.includes(device.deviceId))
    .map(device => ({ deviceId: device.deviceId, label: device.name || device.selfName || settings.lastKnownDeviceNames[device.deviceId] || device.deviceId }));
  const duplicates = new Map<string, number>();
  for (const share of shares) {
    const key = JSON.stringify([share.owner.displayName, share.providerId]);
    const count = (duplicates.get(key) ?? 0) + 1;
    duplicates.set(key, count);
    sources.push({ deviceId: `share:${share.shareId}`, providerId: share.providerId,
      label: t('providerShare.received.fromOwner').replaceAll('{{name}}', () => share.owner.displayName) + (count > 1 ? ` (${count})` : '') });
  }
  const models = await readRemoteCatalog(sources);
  return isCurrent() ? models : [];
}
