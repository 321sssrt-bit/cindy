import {
  connectedProvidersForAgent,
  isModelVisible,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';
import type { GhostAgentModelsResult } from '../../shared/ghost.js';

export const GHOST_AGENT_MODELS_CACHE_MS = 60_000;
export const GHOST_REMOTE_AGENT_MODELS = ['codex', 'claude-code', 'pi'] as const;
export type GhostAgentLocation = { agentDeviceId: string; name: string };
export type GhostAgentLocationsReadResult =
  | { status: 'complete'; locations: GhostAgentLocation[] }
  | { status: 'degraded'; locations: GhostAgentLocation[] };
type GhostAgentModelsOk = Extract<GhostAgentModelsResult, { ok: true }>;

/** Project each provider separately: the same model can support different efforts per route. */
export function projectGhostAgentModels(views: ProviderView[], availableAgents: readonly string[], visibilityOverride: (agent: 'codex' | 'claude-code' | 'pi', providerId: string, modelId: string) => boolean | undefined = () => undefined): GhostAgentModelsResult {
  const models: GhostAgentModelsOk['models'] = [];
  for (const agent of GHOST_REMOTE_AGENT_MODELS) {
    if (!availableAgents.includes(agent)) continue;
    for (const provider of connectedProvidersForAgent(views, agent)) {
      for (const model of provider.models[agent] ?? []) {
        if (!isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }))
          continue;
        models.push({
          visible: isModelVisible(visibilityOverride(agent, provider.id, model.id), model.defaultEnabled),
          id: model.id,
          name: model.name,
          agent,
          providerId: provider.id,
          providerName: provider.name,
          efforts: [...model.efforts],
          defaultEffort: model.defaultEffort,
        });
      }
    }
  }
  return { ok: true, models };
}

/** Plugin GET /agent-models caches successful locations and per-device catalogs for 60s. */
export function createGhostAgentModelsCache(options: { now?: () => number; ttlMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? GHOST_AGENT_MODELS_CACHE_MS;
  let locations: { owner: string; at: number; value: GhostAgentLocation[] } | null = null;
  const locationReads = new Map<string, Promise<GhostAgentLocation[] | undefined>>();
  const catalogs = new Map<string, { at: number; value: GhostAgentModelsOk }>();

  return {
    locations(
      owner: string,
      read: () => Promise<GhostAgentLocationsReadResult>,
    ): Promise<GhostAgentLocation[] | undefined> {
      if (locations && locations.owner === owner && now() - locations.at < ttlMs) {
        return Promise.resolve(locations.value);
      }
      const inFlight = locationReads.get(owner);
      if (inFlight) return inFlight;

      let pending: Promise<GhostAgentLocation[] | undefined>;
      pending = Promise.resolve()
        .then(read)
        .then((result) => {
          if (result.status !== 'complete') return undefined;
          const value = result.locations;
          locations = { owner, at: now(), value };
          return value;
        })
        .catch(() => undefined)
        .finally(() => {
          if (locationReads.get(owner) === pending) locationReads.delete(owner);
        });
      locationReads.set(owner, pending);
      return pending;
    },
    async catalog(
      owner: string,
      agentDeviceId: string,
      read: () => Promise<ProviderView[]>,
    ): Promise<GhostAgentModelsResult> {
      const key = `${owner}\0${agentDeviceId}`;
      const hit = catalogs.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      try {
        const projected = projectGhostAgentModels(await read(), GHOST_REMOTE_AGENT_MODELS);
        if (!projected.ok) return { ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' };
        const value = { ...projected, agentDeviceId };
        catalogs.set(key, { at: now(), value });
        return value;
      } catch {
        return { ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' };
      }
    },
  };
}
