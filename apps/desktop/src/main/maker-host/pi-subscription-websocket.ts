import { type ProxyOptions } from '@cindy/anthropic-compat-proxy';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getChatgptBridgeAuthForDispatch } from './anthropic-responses-bridge-host.js';
import { isOpenAiSubscriptionProviderId } from './codex-account-auth.js';
import { buildChatgptBridgeHeaders } from './chatgpt-bridge-headers.js';
import {
  authenticatePiProxySession,
  getPiProxySessionProvider,
  getPiProxySessionSignal,
  isPiProxySubagentRoute,
} from './pi-proxy-session-auth.js';
import { getSessionProvider, hasHostedSessionModelAccess } from './session-provider-store.js';
import { guestProviderRouteForSession } from './guest-provider-route-store.js';

type Context = Parameters<NonNullable<ProxyOptions['resolveWebSocketUpstream']>>[0];

function authenticatedRoute({ url, headers }: Context): { sessionId: string; providerId: string; signal: AbortSignal } | null {
  if (url !== '/codex/responses' || isAppSessionBoundaryPending()) return null;
  const sessionId = headers['x-cindy-pi-session-id'];
  const token = headers['x-cindy-pi-session-token'];
  const providerId = headers['x-cindy-pi-provider-id'];
  if (!sessionId || !token || !isOpenAiSubscriptionProviderId(providerId)
    || !authenticatePiProxySession(sessionId, token)
    || getPiProxySessionProvider(sessionId, token) !== providerId) return null;
  // These routes require a live per-model grant check for every request body.
  // A transparent socket tunnel cannot enforce that contract.
  if (guestProviderRouteForSession(sessionId) || hasHostedSessionModelAccess(sessionId)) return null;
  const selectedProvider = getSessionProvider(sessionId);
  if (!isPiProxySubagentRoute(sessionId, token) && selectedProvider !== null && selectedProvider !== providerId) return null;
  const signal = getPiProxySessionSignal(sessionId, token);
  return signal && !signal.aborted ? { sessionId, providerId, signal } : null;
}

/** Only authenticated ChatGPT subscription requests can reach the fixed upstream. */
export const resolvePiWebSocketUpstream: NonNullable<ProxyOptions['resolveWebSocketUpstream']> = (ctx) =>
  authenticatedRoute(ctx) ? 'https://chatgpt.com/backend-api' : null;

export function createPiWebSocketRequestPreparer(
  readAuth: (providerId: string) => ReturnType<typeof getChatgptBridgeAuthForDispatch>
    = providerId => getChatgptBridgeAuthForDispatch(providerId),
): NonNullable<ProxyOptions['prepareWebSocketRequest']> {
  return async (ctx) => {
    const owner = activeOwnerScopeKey();
    const route = authenticatedRoute(ctx);
    if (!route) throw new Error('PI_WEBSOCKET_ROUTE_UNAVAILABLE');
    const auth = await readAuth(route.providerId);
    const current = authenticatedRoute(ctx);
    if (owner !== activeOwnerScopeKey() || !current || route.signal !== current.signal
      || route.providerId !== current.providerId || !auth.canDispatch()) throw new Error('PI_WEBSOCKET_ROUTE_CHANGED');
    const headers = buildChatgptBridgeHeaders({ ...auth, sessionId: ctx.headers.session_id ?? route.sessionId });
    // Preserve negotiated transport metadata, never child credentials or Cindy-only headers.
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'openai-beta']) {
      if (ctx.headers[name]) headers[name] = ctx.headers[name];
    }
    return { headers, signal: route.signal, authorize: () => {
      const live = authenticatedRoute(ctx);
      return auth.canDispatch() && owner === activeOwnerScopeKey() && live?.signal === route.signal
        && live.providerId === route.providerId;
    } };
  };
}
