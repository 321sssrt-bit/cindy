import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRefreshBackoff } from '../authRefreshBackoff';
import { AuthApiError, retryAfterDeadline } from '@cindy/auth-client';
import { runRefreshWithReplacementRetry } from '../authRefreshFailure';
import {
  awaitWithStartupTimeout,
  resolveColdStartTimeoutRecovery,
  ColdStartAuthFallbackRegistry,
  commitColdStartRefreshIfCurrent,
} from '../authStartupGate';
import { loginPreparingErrorState } from '../../shared/authIpc';

// Test value (unit): execute the production cold-start and login-action entrypoints with
// in-memory credentials/network. On 2026-10-29 three DNS failures stranded a valid login;
// the pure startup-gate tests did not exercise ongoing retries or the reset action.
// Minimal input: a saved session, repeated status=0 responses, then recovery/manual action.
// Compile once; never load Electron, a real credential store, or sleep in wall-clock time.
const source = ts.createSourceFile(
  'authManager.ts',
  readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  'apiFetch',
  'initialize',
  'refresh',
  'runColdStartRefreshFlow',
  'runAuthRefreshWithReplacementRetry',
  'waitForColdStartRetry',
  'stopColdStartRecovery',
  'runLoginAction',
]);
const compiled = ts.transpileModule(
  `
let authStateEpoch = 0, loginFlowEpoch = 0, accessToken = null, currentUser = null;
let activeAuthRealm = 'global', pendingAuthRealm = null, loginFlowState = null;
let coldStartAuthInFlight = null, coldStartRetryWait = null, refreshTimer = null;
let coldStartRecoveryStopped = false;
let lastAcceptedRefreshToken = null, persistedRefreshTokenNeedsIdentityCheck = false;
let foreignDeviceLocalSignOut = false;
const passiveLocalSignOut = false, settledLoginCommitCount = 0;
const API_FETCH_TIMEOUT_MS = 15000;
const AUTH_REGION = 'global', RUNTIME_REFRESH_RETRY_MS = 60000;
const COLD_START_AUTH_GATE_TIMEOUT_MS = 20000;
const LEGACY_REFRESH_TOKEN_KEY = 'legacy', LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'legacy-account';
const REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
const COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [100, 250];
const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000];
const credentialStoreHealth = { unavailable: false, noteRecovered() {} };
const coldStartTimeoutFallbacks = new ColdStartAuthFallbackRegistry();
const snapshotAuthState = () => ({ isAuthenticated: !!accessToken, user: currentUser });
const snapshotLoggedOutAuthState = snapshotAuthState;
const readPersistedAuthSession = () => saved.session;
const readStoredRefreshTokenCandidates = () => [saved.session?.refreshToken];
const hasPotentiallyPersistedAuthCredentials = () => !!saved.session;
const assertLoginFlowCurrent = (epoch) => { if (epoch !== loginFlowEpoch) throw new Error('superseded'); };
const finishColdStartSignedOut = async () => snapshotAuthState();
const recoverAccountFreeOwnerAtStartup = async () => {
  coldStartTimeoutFallbacks.record(authStateEpoch, authStateEpoch + 1);
  authStateEpoch++; loginFlowEpoch++;
};
const reconcileDesktopActiveAuthSession = async () => saved.session;
${source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
  .map((node) => node.getText(source).replace(/^export /, ''))
  .join('\n')}
return {
  fetch: apiFetch, start: initialize, runtimeRefresh: refresh, reset: () => runLoginAction({ type: 'reset' }),
  manualLogin: () => runLoginAction({ type: 'discover', identifier: 'test@example.invalid' }),
  state: snapshotAuthState,
  fallback: () => { coldStartTimeoutFallbacks.record(authStateEpoch, authStateEpoch + 1); authStateEpoch++; loginFlowEpoch++; },
  changeOwner: () => { authStateEpoch++; accessToken = 'test-new-login'; currentUser = { id: 'other' }; },
};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function setup(random = 0) {
  const saved = { session: { version: 1, realm: 'global', refreshToken: 'test-refresh' } };
  const membership = { id: 'original', kind: 'personal' };
  const ok = {
    ok: true,
    status: 200,
    data: { accessToken: 'test-access', refreshToken: 'test-rotated', membership },
  };
  const request = vi
    .fn<(...args: unknown[]) => Promise<any>>()
    .mockResolvedValue({ ok: false, status: 0, data: null });
  const loadProviders = vi.fn(async () => ({ step: 'identifier' }));
  const commit = vi.fn(async (data) => {
    saved.session.refreshToken = data.refreshToken;
    return 'active';
  });
  const clear = vi.fn(async () => {
    saved.session.refreshToken = '';
  });
  const deps = {
    saved,
    AuthRefreshBackoff: class extends AuthRefreshBackoff {
      constructor() {
        super(
          () => Date.now(),
          () => random,
        );
      }
    },
    AuthApiError,
    retryAfterDeadline,
    authServerUrl: () => 'https://auth.example.invalid',
    net: { fetch: vi.fn() },
    requestErrorMessage: String,
    ColdStartAuthFallbackRegistry,
    commitColdStartRefreshIfCurrent,
    awaitWithStartupTimeout,
    resolveColdStartTimeoutRecovery,
    readReloginFlag: () => null,
    removeSafe: vi.fn(),
    isOwnerChangeShellPending: () => false,
    ownerChangeShellGate: { isPending: () => false },
    sealedLoginFlowCommitDepths: new Set(),
    runRefreshWithReplacementRetry,
    loginPreparingErrorState,
    requestAuthRefresh: request,
    loadClientEndpointsForRealm: vi.fn(async () => {}),
    loadLoginProviders: loadProviders,
    createAuthClient: () => ({ discover: vi.fn() }),
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    readActiveVaultRefreshCandidate: () => null,
    clearConfirmedDeadRefreshTokens: clear,
    resetActiveAuthRealmToBuild: vi.fn(),
    isPassiveSharedUserDataInstance: () => false,
    commitDesktopRefreshCredentials: commit,
    canRestoreAuthSessionForMembership: () => true,
    getActiveAppSession: () => ({ mode: 'signed-out', dataOwnerId: null }),
    withCloudOwnerCommit: async (options: any) => {
      await options.prepareTransition();
      await options.prepareCommit?.();
      options.commit();
    },
    accountSwitchTeardown: vi.fn(async () => {}),
    claimLegacyNamespaceForVerifiedUser: vi.fn(async () => {}),
    mapMembershipToAuthUser: (value: unknown) => value,
    commitCloudAppSession: vi.fn(),
    clearReplacementIntegrationReloadTimers: vi.fn(),
    migrateLocalProviderBindingsAfterCloudCommit: vi.fn(async () => {}),
    scheduleCanaryFlagSync: vi.fn(),
    scheduleXdOrgBetaDefault: vi.fn(),
    scheduleRefresh: vi.fn(),
    getProviderSecretStore: () => ({ reconcileOwner: vi.fn() }),
    notifyRenderer: vi.fn(),
    notifyAuthListeners: vi.fn(),
  };
  const main = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return { ...main, saved, request, ok, commit, clear, loadProviders, deps };
}

describe('saved login recovery after startup network failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps slowly retrying beyond three failures and restores the original account after the startup fallback', async () => {
    const h = setup();
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({ isAuthenticated: false });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.request.mock.calls.length).toBeGreaterThan(3);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.deps.notifyAuthListeners).toHaveBeenCalled();
  });

  it('retry restores the saved login instead of fetching fresh login providers', async () => {
    const h = setup();
    h.request.mockResolvedValue(h.ok);
    await expect(h.reset()).resolves.toMatchObject({ success: true, state: { step: 'completed' } });
    expect(h.loadProviders).not.toHaveBeenCalled();
    expect(h.saved.session.refreshToken).toBe('test-rotated');
  });

  it('manual login stops the waiting recovery without clearing the saved credential', async () => {
    const h = setup();
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await h.manualLogin();
    const attempts = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    await pending;
    await expect(h.start()).resolves.toMatchObject({ isAuthenticated: false });
    expect(h.request).toHaveBeenCalledTimes(attempts);
    expect(h.saved.session.refreshToken).toBe('test-refresh');
  });

  it('retry wakes a network backoff and reuses the saved session immediately', async () => {
    const h = setup();
    void h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValue(h.ok);
    await expect(h.reset()).resolves.toMatchObject({ success: true, state: { step: 'completed' } });
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.loadProviders).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('does not publish or persist an old successful response after an owner change', async () => {
    const h = setup();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.changeOwner();
    resolve(h.ok);
    await expect(pending).resolves.toMatchObject({ user: { id: 'other' } });
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('coalesces multiple retry clicks and runtime refresh behind the pending request', async () => {
    const h = setup();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    void h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    const first = h.reset();
    const second = h.reset();
    await vi.advanceTimersByTimeAsync(0);
    await expect(h.runtimeRefresh()).resolves.toBe(false);
    expect(h.request).toHaveBeenCalledTimes(1);
    resolve(h.ok);
    await expect(first).resolves.toMatchObject({ success: true });
    await expect(second).resolves.toMatchObject({ success: true });
    expect(h.loadProviders).not.toHaveBeenCalled();
  });

  it.each([
    { status: 429, serverWait: undefined },
    { status: 429, serverWait: 120_000 },
    { status: 503, serverWait: 120_000 },
  ])(
    'keeps server cooldown and jitter across retry clicks ($status, $serverWait)',
    async ({ status, serverWait }) => {
      const h = setup(0.5);
      // Exercise HTTP header parsing too: the old path dropped Retry-After on
      // 503, so injecting retryAt directly would miss the premature retry bug.
      h.deps.net.fetch.mockResolvedValue(
        new Response('{}', {
          status,
          headers: serverWait === undefined ? {} : { 'Retry-After': String(serverWait / 1000) },
        }),
      );
      h.request.mockImplementation(() => h.fetch('/api/auth/refresh', { timeoutMs: 0 }));
      void h.start();
      await vi.advanceTimersByTimeAsync(20_000);
      const retry = h.reset();
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(retry).resolves.toMatchObject({
        success: false,
        code: 'AUTH_SERVICE_UNAVAILABLE',
      });
      expect(h.request).toHaveBeenCalledTimes(1);
      h.request.mockResolvedValue(h.ok);
      await vi.advanceTimersByTimeAsync((serverWait ?? 60_000) + 30_000 - 40_001);
      expect(h.request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state()).toMatchObject({ isAuthenticated: true });
    },
  );

  it('retries endpoint discovery without sending the credential to a fallback realm', async () => {
    const h = setup();
    h.deps.loadClientEndpointsForRealm.mockRejectedValue(new Error('offline'));
    void h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).not.toHaveBeenCalled();
    h.deps.loadClientEndpointsForRealm.mockResolvedValue();
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state()).toMatchObject({ isAuthenticated: true });
  });

  it.each(['REFRESH_TOKEN_EXPIRED', 'DEVICE_MISMATCH'])(
    'stops after terminal response %s',
    async (code) => {
      const h = setup();
      h.request.mockResolvedValue({ ok: false, status: 401, data: { error: { code } } });
      await expect(h.start()).resolves.toMatchObject({ isAuthenticated: false });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.clear).toHaveBeenCalledTimes(code === 'REFRESH_TOKEN_EXPIRED' ? 1 : 0);
    },
  );
});
