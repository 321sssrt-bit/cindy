/**
 * 测试价值：openLocalAgentRuntime 的发送、停止和关闭是授权撤销的最终执行点。
 * 规则：通用 API 撤销后不能再启动或发送；原投影测试没有跨 await 的生命周期覆盖。
 * 最小失败输入：setEffort 或重开会话挂起时并发 send / interrupt / close。
 * tier: integration（只使用系统临时目录与可控原生句柄，无 Electron、模型或账号）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('@cindy/maker-core', () => ({
  LOCAL_AGENT_CLIENT: Symbol('local-agent-client'),
  assertSendDispatched: (result: { accepted: boolean }) => {
    if (!result.accepted) throw new Error('not dispatched');
  },
}));
import { openLocalAgentRuntime } from '../runtime.js';
import { createLocalAgentGroupRouteResolver, type LocalAgentRouteResolver } from '../groupRoute.js';
import { LOCAL_AGENT_ROUTE } from '../catalog.js';
import { LOCAL_AGENT_CLIENT } from '@cindy/maker-core';
import { createProviderGroupRemoteClient } from '../../provider-group/remoteClient.js';
import type { AgentEvent } from '@cindy/maker-core';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function handle(id: string) {
  const ended = deferred();
  return {
    sdkSessionId: id,
    send: vi.fn(async () => ({ accepted: true })),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setEffort: vi.fn(async () => {}),
    setInteractionListener: vi.fn(),
    onEvent: vi.fn((_listener: (event: AgentEvent) => void) => () => {}),
    onStatusChange: vi.fn(),
    beginTurnContinuationWait: vi.fn<() => string | null>(() => null),
    getObservedCurrentTurnTerminal: vi.fn(() => ({ kind: 'none' })),
    close: vi.fn(async () => {
      ended.resolve();
    }),
  };
}
async function fixture(options: { route?: { deviceId: string; providerId: string }; resolveRoute?: LocalAgentRouteResolver; resume?: string; trackLoad?: Parameters<typeof openLocalAgentRuntime>[6] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-runtime-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const first = handle('first');
  const maker = { startLocalAgentSession: vi.fn(async (..._args: any[]) => first) };
  const events: unknown[] = [];
  const runtime = await openLocalAgentRuntime(
    maker as any,
    directory,
    {
      isolationKey: 'grant-a',
      mcpName: 'client',
      legacyRuntime: false,
      cwd: directory,
      model: {
        id: 'route',
        label: 'Model',
        provider: 'provider',
        model: 'model',
        engine: 'pi',
        efforts: ['high'],
        images: true,
        isDefault: true,
        ...(options.route ? { [LOCAL_AGENT_ROUTE]: options.route } : {}),
      },
      access: 'none',
      tools: [],
      resume: options.resume,
    },
    {
      url: 'http://127.0.0.1:1/mcp/fixture',
      token: 'invalid-fixture-token',
      emit: (event) => events.push(event),
    },
    undefined,
    options.resolveRoute,
    options.trackLoad,
  );
  cleanups.push(() => runtime.close());
  return { runtime, maker, first, directory, events };
}
const image = { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') };
async function inputFiles(directory: string) {
  const root = path.join(directory, 'clients', 'grant-a');
  const inputs = (await fs.readdir(root)).filter((name) => name.startsWith('input-'));
  return (await Promise.all(inputs.map((name) => fs.readdir(path.join(root, name))))).flat();
}
const message = { parts: [{ type: 'text', text: 'hello' }], effort: 'high' };

describe('local client runtime lifecycle', () => {
  it('registers resolved and resumed handles and reports a silent pending send before it settles', async () => {
    const changed = vi.fn();
    const trackLoad = vi.fn(() => changed);
    const route = { providerId: 'member', groupAssigned: true,
      groupBinding: { providerId: 'group', memberKey: 'device:self:member', groupDeviceId: 'owner' } };
    const f = await fixture({ resolveRoute: async () => route, trackLoad });
    expect(trackLoad).toHaveBeenCalledWith(expect.stringMatching(/^local-agent-/), route, f.first);
    const pending = deferred();
    f.first.send.mockImplementationOnce(async () => { await pending.promise; return { accepted: true }; });
    await f.runtime.call('send', message);
    expect(changed).toHaveBeenCalledTimes(1);
    await f.runtime.call('interrupt', {});
    expect(changed).toHaveBeenCalledTimes(2);
    pending.resolve();
    await Promise.resolve();
    const reopened = await fixture({ resume: f.runtime.id, trackLoad });
    expect(trackLoad).toHaveBeenLastCalledWith(expect.any(String), route, reopened.first);
    await reopened.runtime.call('instructions', { instructions: 'new' });
    await reopened.runtime.call('send', message);
    expect(trackLoad).toHaveBeenCalledTimes(3);
  });
  // Review P1: the application bypassed ordinary task bootstrap and therefore
  // never asked a same-account provider group to select its execution computer.
  // Exercise the real runtime + group wire parser, including a native resume.
  it.each([
    ['device', 'b'.repeat(64), 'b'.repeat(64)],
    ['device', 'c'.repeat(64), undefined],
    ['local', null, 'a'.repeat(64)],
    ['share', 'share:fixture', 'share:fixture'],
  ] as const)('starts the selected %s group member and pins it across instruction rebuilds (%s)', async (kind, memberDevice, expectedDevice) => {
    const invoke = vi.fn(async () => ({ ok: true, result: {
      kind: 'member', member: { kind, agentDeviceId: memberDevice, providerId: 'member-provider' }, label: 'B',
    } }));
    const resolver = createLocalAgentGroupRouteResolver({
      remote: createProviderGroupRemoteClient(invoke), localDeviceId: () => 'c'.repeat(64), assertCurrent: () => {},
    });
    const f = await fixture({ route: { deviceId: 'a'.repeat(64), providerId: 'group-provider' }, resolveRoute: resolver });
    const opts = f.maker.startLocalAgentSession.mock.calls[0][1];
    // The group's local member always uses the group's provider id.
    expect(opts.providerId).toBe(kind === 'local' ? 'group-provider' : 'member-provider');
    expect(opts[LOCAL_AGENT_CLIENT]).toMatchObject({ groupAssigned: true, hostToolsOnly: true, mcpName: 'client' });
    expect(opts[LOCAL_AGENT_CLIENT].agentDeviceId).toBe(expectedDevice);
    expect(opts[LOCAL_AGENT_CLIENT].storageDirectory).toBe(path.join(f.directory, 'clients', 'grant-a', 'pi'));
    expect(invoke).toHaveBeenCalledWith('a'.repeat(64), 'provider-group:remote', [expect.objectContaining({
      action: 'pick', providerId: 'group-provider', agentKind: 'pi', model: 'model', exclude: [],
    })]);
    await f.runtime.call('instructions', { instructions: 'updated' });
    await f.runtime.call('send', message);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(f.maker.startLocalAgentSession.mock.calls[1][1]).toMatchObject({ providerId: opts.providerId, resumeSessionId: 'first' });
    expect(f.maker.startLocalAgentSession.mock.calls[1][1][LOCAL_AGENT_CLIENT]).toEqual(opts[LOCAL_AGENT_CLIENT]);
    // Reopening via the server's persisted opaque binding must also stay on B,
    // even after group strategy/load changes or the member leaves the group.
    const reopened = await fixture({ route: { deviceId: 'a'.repeat(64), providerId: 'group-provider' },
      resolveRoute: resolver, resume: f.runtime.id });
    expect(invoke).toHaveBeenCalledTimes(1);
    const restored = reopened.maker.startLocalAgentSession.mock.calls[0][1];
    expect(restored).toMatchObject({ providerId: opts.providerId, resumeSessionId: 'first' });
    expect(restored[LOCAL_AGENT_CLIENT].agentDeviceId).toBe(expectedDevice);
    expect(restored[LOCAL_AGENT_CLIENT].groupAssigned).toBe(true);
  });

  it.each(['none', 'legacy', 'unavailable', 'denied', 'owner-changed'] as const)('handles group selection %s without silently switching suppliers', async outcome => {
    let current = true;
    const invoke = vi.fn(async () => {
      if (outcome === 'owner-changed') current = false;
      if (outcome === 'legacy' || outcome === 'denied') return { ok: false, error: {
        code: outcome === 'legacy' ? 'CHANNEL_NOT_ALLOWED' : 'ACCESS_REVOKED', message: 'private fixture details',
      } };
      return { ok: true, result: { kind: outcome === 'unavailable' ? 'unavailable' : 'none' } };
    });
    const resolveRoute = createLocalAgentGroupRouteResolver({
      remote: createProviderGroupRemoteClient(invoke), localDeviceId: () => 'c'.repeat(64),
      assertCurrent: () => { if (!current) throw new Error('owner changed'); },
    });
    const opening = fixture({ route: { deviceId: 'a'.repeat(64), providerId: 'group-provider' }, resolveRoute });
    if (outcome === 'owner-changed') await expect(opening).rejects.toThrow('owner changed');
    else if (outcome === 'unavailable' || outcome === 'denied') {
      await expect(opening).rejects.toMatchObject({ code: 'REMOTE_AGENT_UNAVAILABLE',
        message: '远程供应商暂不可用，请在 Cindy 中检查连接或更新远端版本。' });
    } else {
      const f = await opening;
      const opts = f.maker.startLocalAgentSession.mock.calls[0][1];
      expect(opts.providerId).toBe('group-provider');
      expect(opts[LOCAL_AGENT_CLIENT].agentDeviceId).toBe('a'.repeat(64));
      expect(opts[LOCAL_AGENT_CLIENT].groupAssigned).toBeUndefined();
    }
  });

  it('leaves direct shared suppliers to the owner instead of using same-account group management', async () => {
    const pick = vi.fn();
    const f = await fixture({ route: { deviceId: 'share:fixture', providerId: 'shared-provider' },
      resolveRoute: createLocalAgentGroupRouteResolver({ remote: { pick }, localDeviceId: () => null, assertCurrent: () => {} }) });
    expect(pick).not.toHaveBeenCalled();
    expect(f.maker.startLocalAgentSession.mock.calls[0][1][LOCAL_AGENT_CLIENT].agentDeviceId).toBe('share:fixture');
  });

  it('resumes pre-group bindings on their original source and rejects corrupt new bindings', async () => {
    const resolveRoute = vi.fn();
    const route = { deviceId: 'a'.repeat(64), providerId: 'group-provider' };
    const f = await fixture({ route, resolveRoute, resume: 'old-native-thread' });
    expect(resolveRoute).not.toHaveBeenCalled();
    const opts = f.maker.startLocalAgentSession.mock.calls[0][1];
    expect(opts.resumeSessionId).toBe('old-native-thread');
    expect(opts[LOCAL_AGENT_CLIENT].agentDeviceId).toBe(route.deviceId);
    await expect(fixture({ route, resolveRoute, resume: 'local-agent-group-v1:invalid' })).rejects.toMatchObject({ code: 'RESUME_UNAVAILABLE' });
  });

  // Remote application failures must remain actionable without leaking peer diagnostics.
  it('preserves the old-peer error code when rebuilding an application session', async () => {
    const f = await fixture();
    f.maker.startLocalAgentSession.mockRejectedValueOnce(new Error('[REMOTE_AGENT_PEER_TOO_OLD] private peer details'));
    await f.runtime.call('instructions', { instructions: 'updated' });
    await expect(f.runtime.call('send', message)).rejects.toMatchObject({
      code: 'REMOTE_AGENT_PEER_TOO_OLD',
      message: '远程供应商暂不可用，请在 Cindy 中检查连接或更新远端版本。',
    });
    expect(f.first.send).not.toHaveBeenCalled();
  });
  it('does not auto-approve a shared supplier credential confirmation', async () => {
    const f = await fixture();
    const listener = f.first.setInteractionListener.mock.calls[0][0];
    const answer = await listener({kind:'permission',toolName:'read',metadata:{hostOwnedConfirmation:'shared_provider_credential'}});
    expect(answer).toEqual({kind:'permission',behavior:'deny',reason:'host_interaction_unavailable'});
  });
  it('passes slash-prefixed app text as a literal instead of rejecting paths or running a native command', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: [{ type: 'text', text: '/workspace/example' }] });
    expect(f.first.send).toHaveBeenCalledWith({
      type: 'user',
      content: [{ type: 'text', text: ' /workspace/example' }],
    });
  });
  it('keeps the app execution busy across a provider continuation until Session observes its final boundary', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: message.parts });
    const deliver = f.first.onEvent.mock.calls[0][0];
    f.first.beginTurnContinuationWait.mockReturnValueOnce('active');
    deliver({ type: 'done', turnContinuationId: 7, data: { status: 'completed' } });
    await expect(f.runtime.call('send', { parts: message.parts })).rejects.toMatchObject({
      code: 'BUSY',
    });
    f.first.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    deliver({ type: 'done', data: { status: 'completed' } });
    await f.runtime.call('send', { parts: message.parts });
    expect(f.first.send).toHaveBeenCalledTimes(2);
  });
  it('reserves a send before awaiting effort so a concurrent send cannot double-submit', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.setEffort.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    const sending = f.runtime.call('send', message);
    await entered.promise;
    const rejected = expect(f.runtime.call('send', message)).rejects.toMatchObject({
      code: 'BUSY',
    });
    held.resolve();
    await sending;
    await rejected;
    expect(f.first.send).toHaveBeenCalledTimes(1);
  });
  it('does not send after an interrupt arrives during effort preparation', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.setEffort.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'INTERRUPTED' });
    await entered.promise;
    await f.runtime.call('interrupt', {});
    held.resolve();
    await rejected;
    expect(f.first.send).not.toHaveBeenCalled();
  });
  it('does not restart an engine after close during an instructions rebuild', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.close.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    await f.runtime.call('instructions', { instructions: 'new context' });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    await entered.promise;
    const closing = f.runtime.close();
    held.resolve();
    await closing;
    await rejected;
    expect(f.maker.startLocalAgentSession).toHaveBeenCalledTimes(1);
    expect(f.first.send).not.toHaveBeenCalled();
  });
  it('closes a late replacement engine instead of sending after its grant was closed', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred(),
      late = handle('late');
    cleanups.push(() => late.close());
    f.maker.startLocalAgentSession.mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
      return late;
    });
    await f.runtime.call('instructions', { instructions: 'new context' });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    await entered.promise;
    await f.runtime.close();
    held.resolve();
    await rejected;
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.close).toHaveBeenCalledWith({ reason: 'account-boundary' });
    expect(late.send).not.toHaveBeenCalled();
  });
  it('rebuilds again when instructions change while a rebuild is still starting', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred(),
      second = handle('second'),
      third = handle('third');
    cleanups.push(() => second.close(), () => third.close());
    f.maker.startLocalAgentSession
      .mockImplementationOnce(async () => {
        entered.resolve();
        await held.promise;
        return second;
      })
      .mockImplementationOnce(async () => third);
    await f.runtime.call('instructions', { instructions: 'first update' });
    const sending = f.runtime.call('send', message);
    await entered.promise;
    await f.runtime.call('instructions', { instructions: 'latest' });
    held.resolve();
    await sending;
    second.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    second.onEvent.mock.calls[0][0]({ type: 'done', data: { status: 'completed' } });
    await f.runtime.call('send', message);
    expect(f.maker.startLocalAgentSession).toHaveBeenLastCalledWith(
      'pi',
      expect.objectContaining({ userPrompt: 'latest' }),
    );
    expect(third.send).toHaveBeenCalledTimes(1);
  });
  it.each(['declines', 'rejects'] as const)('releases execution and reports settled load when the engine %s a send', async (outcome) => {
    const changed = vi.fn();
    const f = await fixture({ trackLoad: () => changed });
    if (outcome === 'declines') f.first.send.mockResolvedValueOnce({ accepted: false });
    else f.first.send.mockRejectedValueOnce(new Error('fixture engine unavailable'));
    await f.runtime.call('send', message);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.runtime.call('send', message)).resolves.toEqual({}));
    expect(f.first.send).toHaveBeenCalledTimes(2);
  });
  it('ends a send that an interrupt cancels before the supplier accepts it', async () => {
    const f = await fixture(),
      reserved = deferred();
    let cancel!: (value: { accepted: boolean }) => void;
    f.first.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          cancel = resolve;
          reserved.resolve();
        }),
    );
    f.first.abort.mockImplementationOnce(async () => cancel({ accepted: false }));
    await f.runtime.call('send', { parts: message.parts });
    await reserved.promise;
    await f.runtime.call('interrupt', {});
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({
        type: 'turn_end',
        data: { status: 'interrupted', message: '' },
      }),
    );
  });
  it('keeps the effort chosen by send.effort when instructions rebuild the session', async () => {
    const f = await fixture(),
      second = handle('second');
    cleanups.push(() => second.close());
    f.maker.startLocalAgentSession.mockImplementationOnce(async () => second);
    await f.runtime.call('send', message);
    f.first.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    f.first.onEvent.mock.calls[0][0]({ type: 'done', data: { status: 'completed' } });
    await f.runtime.call('instructions', { instructions: 'new context' });
    await f.runtime.call('send', { parts: message.parts });
    expect(f.maker.startLocalAgentSession).toHaveBeenLastCalledWith(
      'pi',
      expect.objectContaining({ effort: 'high', userPrompt: 'new context' }),
    );
  });
  it('removes accepted input images once their turn settles', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: [image] });
    expect(await inputFiles(f.directory)).toHaveLength(1);
    f.first.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    f.first.onEvent.mock.calls[0][0]({ type: 'done', data: { status: 'completed' } });
    await vi.waitFor(async () => expect(await inputFiles(f.directory)).toEqual([]));
  });
  it('removes images written for a send that is rejected before the engine takes it', async () => {
    const f = await fixture();
    await expect(
      f.runtime.call('send', { parts: [image, { type: 'unsupported' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    f.first.setEffort.mockRejectedValueOnce(new Error('effort unavailable'));
    await expect(f.runtime.call('send', { ...message, parts: [image] })).rejects.toThrow(
      'effort unavailable',
    );
    expect(await inputFiles(f.directory)).toEqual([]);
    await f.runtime.call('send', { parts: [image] });
    expect(await inputFiles(f.directory)).toHaveLength(1);
  });
});
