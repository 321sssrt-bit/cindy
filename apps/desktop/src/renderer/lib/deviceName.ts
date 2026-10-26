import { deviceDisplayName as displayName, type DeviceNameSource } from '@cindy/maker-shared/device-list';
import i18n from '@/i18n';

export function deviceDisplayName(deviceId: string, name?: string | null, devices: readonly DeviceNameSource[] = []): string {
  return displayName(deviceId, name, i18n.t('bots.cloud.unknownDevice'), devices);
}
