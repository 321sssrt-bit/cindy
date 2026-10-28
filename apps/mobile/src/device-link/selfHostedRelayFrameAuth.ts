/**
 * 手机的自建中转设备签名(docs/self-hosted-relay-plan.md §16):给 DeviceLinkClient 的 `frameAuth`。
 * 经中转发出的每条对端消息用本机签名密钥签名;只签名、不核对收到的消息(原因见 DeviceLinkContext
 * 里 `frameAuth` 处的说明),所以也不需要拉取证书列表。
 */
import { RelayFrameAuthenticator, type DeviceLinkFrameAuth } from '@cindy/device-link';

import { mobileDebugLog } from '@/debug/mobileDebugLog';

import { mobileRelayAuthCrypto } from './relayAuthCrypto';
import { getActiveSelfHostedRelay } from './selfHostedRelayRouting';

/** 本机密钥缺失或损坏:不能签名就不能安全通信。发出的消息不带签名(电脑会丢弃),收到的全部丢弃。 */
const UNUSABLE: DeviceLinkFrameAuth = { sign: () => undefined, verify: () => false };

let cached: { key: string; frameAuth: DeviceLinkFrameAuth } | null = null;

/** DeviceLinkClient 每帧调用:官方中转返回 null(不签名、不核对,wire 与旧版相同)。 */
export function currentSelfHostedRelayFrameAuth(): DeviceLinkFrameAuth | null {
  const relay = getActiveSelfHostedRelay();
  const signing = relay?.signing;
  if (!relay || !signing) {
    cached = null;
    return relay ? UNUSABLE : null;
  }
  // 中转或本机签名身份一变就重建;种子只在内存里比较,不进日志。
  const key = [relay.relayId, signing.deviceId, signing.ownerPublicKey, signing.seed].join('\n');
  if (cached?.key === key) return cached.frameAuth;
  try {
    const authenticator = new RelayFrameAuthenticator({
      crypto: mobileRelayAuthCrypto,
      relayId: relay.relayId,
      deviceId: signing.deviceId,
      seed: signing.seed,
      ownerPublicKey: signing.ownerPublicKey,
    });
    cached = { key, frameAuth: { sign: (frame) => authenticator.sign(frame), verify: () => true } };
  } catch {
    mobileDebugLog('warn', 'device-link', 'self-hosted relay signing key is unusable');
    cached = { key, frameAuth: UNUSABLE };
  }
  return cached.frameAuth;
}
