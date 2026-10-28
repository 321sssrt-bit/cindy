import { useEffect, useRef, useState } from "react";
import { Alert, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  PluginModelPickerRequest,
  PluginModelSelection,
} from "@cindy/device-link";
import { useDeviceProviders } from "@/device-link/useDeviceProviders";
import { useMobileMakerTransport } from "@/device-link/useMobileMakerTransport";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { ModelPickerSheet } from "@/session/ModelPickerSheet";
import {
  normalizeMobileAgentCapabilities,
  type MobileAgentCapabilities,
} from "@/session/agentCapabilities";

/** Native selector reads the execution computer's catalog; no local defaults are written. */
export function PluginModelPicker({
  request,
  deviceId,
  onAnswer,
}: {
  request: PluginModelPickerRequest;
  deviceId: string;
  onAnswer(
    route: PluginModelSelection | null,
  ): Promise<{ handled: boolean; accepted: boolean }>;
}) {
  const { t } = useTranslation();
  const providers = useDeviceProviders(deviceId),
    maker = useMobileMakerTransport(deviceId);
  const [capabilities, setCapabilities] =
    useState<MobileAgentCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = useRef(getMobileAuthOwner()).current,
    alive = useRef(true),
    lock = useRef(false),
    finished = useRef(false);
  const current = () => alive.current && isMobileAuthOwnerCurrent(owner);
  const agent =
    request.initial?.agentKind === "cc"
      ? "claude-code"
      : (request.initial?.agentKind ?? "codex");
  useEffect(() => {
    alive.current = true;
    void maker
      .getCapabilities(agent)
      .then((raw) => {
        if (current()) setCapabilities(normalizeMobileAgentCapabilities(raw));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [maker, agent]);
  const answer = async (route: PluginModelSelection | null) => {
    if (lock.current || finished.current || !current()) return false;
    lock.current = true;
    setBusy(true);
    try {
      const result = await onAnswer(route);
      if (result.accepted) {
        finished.current = true;
        return true;
      }
      if (current()) Alert.alert(t("plugins.modelsUnavailable"));
    } catch {
      if (current()) Alert.alert(t("plugins.modelsUnavailable"));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
    return false;
  };
  return (
    <ModelPickerSheet
      visible
      title={`${request.ghostName} · ${t("models.picker.title")}`}
      onClose={() => {
        void answer(null);
      }}
      agentKind={agent}
      providers={providers.providers}
      providersReady={providers.ready}
      providersUnsupported={providers.unsupported}
      modelVisibilityOverrides={providers.modelVisibilityOverrides}
      flatOptions={[]}
      capabilities={capabilities}
      activeModelId={request.initial?.model ?? ""}
      selectedProviderId={request.initial?.providerId ?? null}
      selectedEffort={request.initial?.effort ?? ""}
      selectedFastMode={request.initial?.fastMode ?? false}
      loading={providers.loading}
      disabled={busy}
      hidePermissionTrigger
      activePermissionMode=""
      permissionOptions={[]}
      onSelectPermissionMode={() => {}}
      onSelectFlatModel={() => {}}
      onSelectProviderRow={() => {}}
      keyboardAvoidingBehavior={Platform.OS === "ios" ? "padding" : "height"}
      emptyHint={t("plugins.modelsUnavailable")}
      unified={{
        scope: JSON.stringify([owner.accountKey, deviceId]),
        agents: ["claude-code", "codex", "pi"],
        loadCapabilities: async (kind) => {
          const result = normalizeMobileAgentCapabilities(
            await maker.getCapabilities(kind),
          );
          if (!result || !current())
            throw new Error("CAPABILITIES_UNAVAILABLE");
          return result;
        },
        onSelect: (value) =>
          answer({
            agentKind: value.agent === "claude-code" ? "cc" : value.agent,
            providerId: value.providerId,
            model: value.modelId,
            effort: value.effort ?? "",
            fastMode: value.fast,
          }),
      }}
    />
  );
}
