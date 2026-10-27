import type { ReactElement } from 'react';

import { Tip } from '@/components/ui/tooltip';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';

interface Props {
  path: string | null | undefined;
  deviceId?: string | null;
  deviceName?: string | null;
  remoteHostId?: string | null;
  children: ReactElement;
}

export function WorkingDirectoryTip({ path, deviceId, deviceName, remoteHostId, children }: Props) {
  const devices = useDeviceLinkDeviceList();
  // The directory belongs to the task's computer, even if its Agent runs elsewhere.
  const directoryDeviceName = deviceId
    ? devices?.find((device) => device.deviceId === deviceId)?.name || deviceName || deviceId
    : null;

  return (
    <Tip
      text={
        path ? (
          <>
            {directoryDeviceName && <div>{directoryDeviceName}</div>}
            {remoteHostId && <div>Host: {remoteHostId}</div>}
            <div>{path}</div>
          </>
        ) : null
      }
      mono
      side="top"
      contentClassName="max-w-[min(420px,calc(100vw-16px))]"
    >
      {children}
    </Tip>
  );
}
