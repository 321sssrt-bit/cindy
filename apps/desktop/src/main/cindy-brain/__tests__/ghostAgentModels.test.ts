import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { createGhostAgentModelsCache, projectGhostAgentModels } from '../ghostAgentModels.js';

const provider = (id: string, efforts: string[]) =>
  ({
    id,
    name: id,
    source: 'user',
    connected: true,
    agents: ['codex'],
    routing: { codex: { enabled: true } },
    models: {
      codex: [
        { id: 'model', name: 'Model', mode: 'chat', efforts, defaultEffort: efforts[0] ?? null },
      ],
    },
    auth: { apiKey: 'secret' },
    endpoint: 'private',
    subscriptionAccount: { identity: 'private' },
  }) as unknown as ProviderView;

describe('plugin model projection', () => {
  it('uses per-route user visibility before catalog defaults without removing hidden models', () => {
    const a = provider('a', ['high']);
    a.models.codex![0]!.defaultEnabled = false;
    const b = provider('b', ['high']);
    const result = projectGhostAgentModels([a,b], ['codex'], (_, id) => id === 'a' ? true : false);
    expect(result.ok && result.models.map(m => m.visible)).toEqual([true,false]);
    const defaults = projectGhostAgentModels([a,b], ['codex']);
    expect(defaults.ok && defaults.models.map(m => m.visible)).toEqual([false,true]);
  });
  it('preserves per-provider efforts and exposes only explicit metadata fields', () => {
    const result = projectGhostAgentModels([
      provider('a', ['low', 'high']),
      provider('b', ['medium']),
    ], ['codex']);
    expect(result).toEqual({
      ok: true,
      models: [
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'a',
          providerName: 'a',
          efforts: ['low', 'high'],
          defaultEffort: 'low',
        },
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'b',
          providerName: 'b',
          efforts: ['medium'],
          defaultEffort: 'medium',
        },
      ],
    });
  });
  it('excludes disconnected, suspended, disabled, retired, paid-locked and non-chat routes', () => {
    const a = provider('a', []);
    a.models.codex!.push(
      ...['disabled', 'retired', 'locked', 'image'].map((id) => ({
        ...a.models.codex![0]!,
        id,
        disabled: id === 'disabled',
        status: id === 'retired' ? ('retired' as const) : undefined,
        availability: id === 'locked' ? ('requires_payment' as const) : undefined,
        mode: id === 'image' ? 'image' : 'chat',
      })),
    );
    const result = projectGhostAgentModels([
      a,
      { ...provider('offline', []), connected: false },
      { ...provider('paused', []), suspended: true },
    ], ['codex']);
    expect(result).toEqual({
      ok: true,
      models: [
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'a',
          providerName: 'a',
          efforts: [],
          defaultEffort: null,
        },
      ],
    });
  });
  it('only exposes registered runtimes, including registration after initial startup', () => {
    const p = provider('p', ['high']);
    p.agents = ['codex', 'pi'];
    p.routing.pi = p.routing.codex;
    p.models.pi = [...p.models.codex!];
    expect(projectGhostAgentModels([p], [])).toEqual({ ok: true, models: [] });
    const before = projectGhostAgentModels([p], ['codex']);
    expect(before.ok && before.models.map(m => m.agent)).toEqual(['codex']);
    const after = projectGhostAgentModels([p], ['codex', 'pi']);
    expect(after.ok && after.models.map(m => m.agent)).toEqual(['codex', 'pi']);
  });

  it('projects a remote location with catalog defaults and distinct provider rows', async () => {
    const anthropic = provider('anthropic', ['high']);
    const api = provider('anthropic-api', ['high']);
    anthropic.models.codex![0]!.defaultEnabled = false;
    const result = await createGhostAgentModelsCache().catalog('owner', 'claude', async () => [anthropic, api]);
    expect(result).toEqual({
      ok: true,
      agentDeviceId: 'claude',
      models: [
        {
          visible: false,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'anthropic',
          providerName: 'anthropic',
          efforts: ['high'],
          defaultEffort: 'high',
        },
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'anthropic-api',
          providerName: 'anthropic-api',
          efforts: ['high'],
          defaultEffort: 'high',
        },
      ],
    });
  });

  /**
   * 测试价值
   * - 生产入口与可观察结果：插件目录缓存同 owner+device 的并发读取只请求一次；失败结果不缓存，下一次读取返回目录。
   * - Bug／规则依据：makecindy/cindy#7472 Greptile「同时读取会重复发请求」。
   * - 现有覆盖缺口：既有用例只覆盖已完成的目录结果，没有覆盖空缓存下的并发读取或失败清理。
   * - 最小失败输入：同一 owner 和 device 两次并发读取，首次拒绝、重试返回一个可见模型。
   * - tier：unit。
   * - 实测耗时：0.59 s（修复后单文件运行，macOS arm64）。
   */
  it('shares an in-flight catalog read for the same owner and device, then retries after failure', async () => {
    const cache = createGhostAgentModelsCache();
    const read = vi.fn<() => Promise<ProviderView[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([provider('recovered', ['high'])]);

    const [first, second] = await Promise.all([
      cache.catalog('owner', 'device', read),
      cache.catalog('owner', 'device', read),
    ]);

    const unavailable = { ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' };
    expect(first).toEqual(unavailable);
    expect(second).toEqual(unavailable);
    expect(read).toHaveBeenCalledTimes(1);

    await expect(cache.catalog('owner', 'device', read)).resolves.toMatchObject({
      ok: true,
      agentDeviceId: 'device',
      models: [{ providerId: 'recovered' }],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
