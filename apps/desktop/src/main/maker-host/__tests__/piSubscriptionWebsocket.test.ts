import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSocketMessageTransform } from '@cindy/anthropic-compat-proxy';

const state = vi.hoisted(() => ({ owner: 'owner-a', pending: false, provider: 'openai' as string | null, guest: false, hosted: false, fastAllowed: true }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner, isAppSessionBoundaryPending: () => state.pending }));
vi.mock('../codex-account-auth.js', () => ({ isOpenAiSubscriptionProviderId: (id: string) => id === 'openai' || id === 'account-b' }));
vi.mock('../session-provider-store.js', () => ({ getSessionProvider: () => state.provider, hasHostedSessionModelAccess: () => state.hosted }));
vi.mock('../guest-provider-route-store.js', () => ({ guestProviderRouteForSession: () => state.guest ? {} : null }));
vi.mock('../anthropic-responses-bridge-host.js', () => ({ getChatgptBridgeAuthForDispatch: vi.fn() }));

vi.mock('../subscription-fast-request-policy.js', () => ({ subscriptionRequestAllowsFast: vi.fn(() => state.fastAllowed) }));

import { subscriptionRequestAllowsFast } from '../subscription-fast-request-policy.js';
import { createPiWebSocketRequestPreparer, resolvePiWebSocketUpstream, piWebSocketTransforms } from '../pi-subscription-websocket.js';
import { registerPiProxySession, resetPiProxySessionsForTest } from '../pi-proxy-session-auth.js';

const context = (provider = 'openai', token = 'fixture-token') => ({ url: '/codex/responses', headers: {
  'x-cindy-pi-session-id': 'fixture-session', 'x-cindy-pi-session-token': token,
  'x-cindy-pi-provider-id': provider, authorization: 'Bearer child-placeholder',
  'chatgpt-account-id': 'child-placeholder', session_id: 'native-session',
  'sec-websocket-key': 'fixture-handshake', 'sec-websocket-version': '13',
  'openai-beta': 'responses_websockets=2026-02-06',
} });

function frame(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body));
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
  header[0] = 129; header[1] = 128 | (payload.length < 126 ? payload.length : 126);
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  mask.copy(header, header.length - 4);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]!;
  return Buffer.concat([header, payload]);
}

describe('Pi subscription WebSocket routing', () => {
  beforeEach(() => {
    resetPiProxySessionsForTest();
    state.owner = 'owner-a'; state.pending = false; state.provider = 'openai';
    state.guest = false; state.hosted = false; state.fastAllowed = true;
  });

  // Regression #7427: the native Fast intent can remain true before the policy poll.
  // A reused socket must enforce the live account/task restriction on the actual request.
  it('downgrades stale Fast intent on reused sockets and preserves unrelated messages', async () => {
    registerPiProxySession('fixture-session', 'fixture-token', () => 'openai');
    const { outbound, inbound } = piWebSocketTransforms(context());
    const messages: unknown[] = [];
    const decode = createWebSocketMessageTransform(true, bytes => {
      messages.push(JSON.parse(bytes.toString())); return bytes;
    });
    outbound.pipe(decode); decode.resume();
    const send = (body: unknown) => new Promise<void>((resolve, reject) =>
      outbound.write(frame(body), error => error ? reject(error) : resolve()));
    try {
      const request = { type: 'response.create', model: 'gpt-6-astra', service_tier: 'priority', previous_response_id: 'resp_fixture', input: [{ type: 'function_call_output', call_id: 'call_fixture', output: 'next' }] };
      await send(request);
      expect(messages.at(-1)).toEqual(request);
      state.fastAllowed = false; // No timer, setFastMode, or notification has run.
      await send(request);
      expect(messages.at(-1)).toEqual({ ...request, service_tier: 'default' });
      expect(subscriptionRequestAllowsFast).toHaveBeenLastCalledWith('fixture-session', 'openai');
      const cancel = { type: 'response.cancel', response_id: 'resp_fixture' };
      await send(cancel); expect(messages.at(-1)).toEqual(cancel);
      state.fastAllowed = true;
      await send({ ...request, service_tier: 'default' });
      expect(messages.at(-1)).toEqual({ ...request, service_tier: 'default' });
    } finally { outbound.destroy(); inbound.destroy(); decode.destroy(); }
  });

  it('keeps hosted and shared-provider routes on HTTP for live per-model authorization', () => {
    registerPiProxySession('fixture-session', 'fixture-token', () => 'openai');
    state.guest = true; expect(resolvePiWebSocketUpstream(context())).toBeNull();
    state.guest = false; state.hosted = true; expect(resolvePiWebSocketUpstream(context())).toBeNull();
  });

  it('rejects forged, wrong-provider, expired, non-subscription and wrong-path requests', () => {
    expect(resolvePiWebSocketUpstream(context())).toBeNull();
    const close = registerPiProxySession('fixture-session', 'fixture-token', () => 'openai');
    expect(resolvePiWebSocketUpstream(context())).toBe('https://chatgpt.com/backend-api');
    expect(resolvePiWebSocketUpstream(context('openai', 'forged'))).toBeNull();
    expect(resolvePiWebSocketUpstream(context('account-b'))).toBeNull();
    expect(resolvePiWebSocketUpstream(context('xai'))).toBeNull();
    expect(resolvePiWebSocketUpstream({ ...context(), url: '/messages' })).toBeNull();
    state.provider = 'account-b'; expect(resolvePiWebSocketUpstream(context())).toBeNull();
    state.provider = 'openai'; state.pending = true; expect(resolvePiWebSocketUpstream(context())).toBeNull();
    state.pending = false; close(); expect(resolvePiWebSocketUpstream(context())).toBeNull();
  });

  it('injects the selected account, preserves the native session and strips local secrets', async () => {
    state.provider = 'account-b';
    const close = registerPiProxySession('fixture-session', 'fixture-token', () => 'account-b');
    const read = vi.fn(async () => ({ accessToken: 'fixture-upstream-token', accountId: 'fixture-upstream-account', canDispatch: () => true }));
    const prepared = await createPiWebSocketRequestPreparer(read)(context('account-b'));
    expect(read).toHaveBeenCalledWith('account-b');
    expect(prepared.headers).toMatchObject({ authorization: 'Bearer fixture-upstream-token',
      'chatgpt-account-id': 'fixture-upstream-account', session_id: 'native-session',
      'openai-beta': 'responses_websockets=2026-02-06', 'sec-websocket-key': 'fixture-handshake' });
    expect(Object.keys(prepared.headers).some(key => key.startsWith('x-cindy-'))).toBe(false);
    expect(prepared.signal.aborted).toBe(false);
    close(); expect(prepared.signal.aborted).toBe(true);
  });

  it('rejects revoked or replaced native OAuth proof during establishment and socket reuse', async () => {
    registerPiProxySession('fixture-session', 'fixture-token', () => 'openai');
    let connected = true;
    const prepare = createPiWebSocketRequestPreparer(async () => ({ accessToken: 'fixture-token', accountId: null, canDispatch: () => connected }));
    const prepared = await prepare(context());
    expect(prepared.authorize?.()).toBe(true);
    connected = false;
    expect(prepared.authorize?.()).toBe(false);
    await expect(prepare(context())).rejects.toThrow('PI_WEBSOCKET_ROUTE_CHANGED');
  });

  it.each(['owner', 'pending', 'provider', 'guest', 'hosted'])('rejects %s changes on an already established socket', async kind => {
    registerPiProxySession('fixture-session', 'fixture-token', () => 'openai');
    const prepared = await createPiWebSocketRequestPreparer(async () => ({ accessToken: 'fixture-token', accountId: null, canDispatch: () => true }))(context());
    expect(prepared.authorize?.()).toBe(true);
    if (kind === 'owner') state.owner = 'owner-b';
    if (kind === 'pending') state.pending = true;
    if (kind === 'provider') state.provider = 'account-b';
    if (kind === 'guest') state.guest = true;
    if (kind === 'hosted') state.hosted = true;
    expect(prepared.authorize?.()).toBe(false);
  });

  it.each(['owner', 'pending', 'provider', 'revoked', 'replaced'])('revalidates %s changes while authentication is pending', async kind => {
    const close = registerPiProxySession('fixture-session', 'fixture-token', () => 'openai');
    const read = vi.fn(async () => {
      if (kind === 'owner') state.owner = 'owner-b';
      if (kind === 'pending') state.pending = true;
      if (kind === 'provider') state.provider = 'account-b';
      if (kind === 'revoked') close();
      if (kind === 'replaced') registerPiProxySession('fixture-session', 'fixture-token', () => 'openai');
      return { accessToken: 'fixture-token', accountId: null, canDispatch: () => true };
    });
    await expect(createPiWebSocketRequestPreparer(read)(context())).rejects.toThrow('PI_WEBSOCKET_ROUTE_CHANGED');
  });

  it('keeps provider-scoped children independent of the parent route and token lifetime', async () => {
    const closeParent = registerPiProxySession('fixture-session', 'parent-token', () => 'openai');
    registerPiProxySession('fixture-session', 'fixture-token', () => 'account-b', { scope: 'subagent-route' });
    const prepared = await createPiWebSocketRequestPreparer(async () => ({ accessToken: 'fixture-token', accountId: null, canDispatch: () => true }))(context('account-b'));
    closeParent(); expect(prepared.signal.aborted).toBe(false);
    expect(resolvePiWebSocketUpstream(context('account-b'))).toBe('https://chatgpt.com/backend-api');
  });
});
