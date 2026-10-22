import type { ComponentProps } from 'react';
import { ModelSelector, ModelSelectorContent } from './ModelSelector';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';

interface ModelRouteContext {
  /** The task host; omitted for this computer. */
  deviceId?: string;
  /** The selected Agent location; null/omitted means the task host. */
  agentDeviceId?: string | null;
  sshRemote?: boolean;
}

function useModelRouteOptions({ deviceId, agentDeviceId, sshRemote }: ModelRouteContext) {
  const locations = useModelRouteDevices({
    controlledDeviceId: deviceId ?? null,
    leadAgentDeviceId: agentDeviceId,
    sshRemote,
  });
  return locations.devices ? {
    devices: locations.devices,
    selectedDeviceId: agentDeviceId ?? null,
    homeDeviceId: deviceId,
  } : undefined;
}

/** Full control using the common task/worker location catalog. */
export function ModelRouteSelector({ agentDeviceId, sshRemote, deviceId, ...props }:
  Omit<ComponentProps<typeof ModelSelector>, 'remoteAgent'> & ModelRouteContext) {
  const remoteAgent = useModelRouteOptions({ deviceId, agentDeviceId, sshRemote });
  return <ModelSelector {...props} deviceId={deviceId} remoteAgent={remoteAgent} />;
}

/** The same selector inside an existing popover; callbacks retain the full selection. */
export function ModelRouteSelectorContent({ agentDeviceId, sshRemote, deviceId, ...props }:
  Omit<ComponentProps<typeof ModelSelectorContent>, 'remoteAgent'> & ModelRouteContext) {
  const remoteAgent = useModelRouteOptions({ deviceId, agentDeviceId, sshRemote });
  return <ModelSelectorContent {...props} deviceId={deviceId} remoteAgent={remoteAgent} />;
}
