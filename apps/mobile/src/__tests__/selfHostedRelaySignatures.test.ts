/**
 * 测试价值
 * - 生产入口与可观察结果：手机加入流程用的 `mobileRelayAuthCrypto`(@noble)经 `createRelayJoinIdentity` /
 *   `acceptRelayDeviceCert` 加入,DeviceLinkClient 的 `currentSelfHostedRelayFrameAuth()` 给对端帧签名;
 *   电脑端(node:crypto)核对配对证明、签发证书,并用 `RelayFrameAuthenticator` 判定手机签名的帧为 'ok'、
 *   篡改内容的帧为 'bad-signature';不是链接里主人签发的证书在手机上被拒(OWNER_MISMATCH);官方中转不签名。
 * - Bug／规则依据：docs/self-hosted-relay-plan.md §16 设备签名。手机与电脑是两套 Ed25519 / SHA-256 / HMAC /
 *   UTF-8 实现,任何一处字节差异都会让电脑丢弃手机发出的全部消息(自建中转下手机整体不可用)或让手机加入失败。
 * - 现有覆盖缺口：packages/device-link 的签名测试两端都用 node:crypto,不覆盖 @noble 实现与跨实现兼容。
 * - 最小失败输入：一条内容含中文与 emoji 的 invoke 帧(纯 JS UTF-8 编码 vs node Buffer 编码)。
 * - tier：unit(纯计算,node 环境;expo-crypto 的随机数换成 node:crypto)。
 * - 实测耗时：单独运行 1.8 秒,用例本身 38ms(apps/mobile 下 npx vitest run src/__tests__/selfHostedRelaySignatures.test.ts)。
 */
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  acceptRelayDeviceCert,
  createRelayJoinIdentity,
  createRelayPairSecret,
  createRelaySigningKey,
  issueRelayDeviceCert,
  PROTOCOL_VERSION,
  RelayFrameAuthenticator,
  verifyRelayPairProof,
  type Envelope,
  type RelayJoinLink,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';

vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));

import { mobileRelayAuthCrypto } from '@/device-link/relayAuthCrypto';
import { currentSelfHostedRelayFrameAuth } from '@/device-link/selfHostedRelayFrameAuth';
import { __testing as relayRouting, setActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';

afterEach(() => relayRouting.reset());

it('phone (@noble) and computer (node:crypto) accept each other’s pairing proof, certificate and frame signatures', () => {
  const relayId = 'relay-7f3c';
  const phoneId = 'phone-1';
  const computerId = 'computer-1';
  const owner = createRelaySigningKey(nodeRelayAuthCrypto);
  const link: RelayJoinLink = {
    baseUrl: 'https://relay.home.example',
    code: 'C'.repeat(32),
    ownerPublicKey: owner.publicKey,
    pairSecret: createRelayPairSecret(nodeRelayAuthCrypto),
  };

  // 加入:手机生成密钥与配对证明,主人电脑核对后签发证书,手机用链接里的主人公钥核对。
  const identity = createRelayJoinIdentity(mobileRelayAuthCrypto, link, relayId, phoneId);
  expect(verifyRelayPairProof(nodeRelayAuthCrypto, link.pairSecret, {
    relayId, deviceId: phoneId, publicKey: identity.publicKey, proof: identity.proof,
  })).toBe(true);
  const certFields = { relayId, deviceId: phoneId, publicKey: identity.publicKey, role: 'member' as const, issuedAt: 1 };
  const cert = issueRelayDeviceCert(nodeRelayAuthCrypto, owner.seed, certFields);
  const accept = { relayId, deviceId: phoneId, publicKey: identity.publicKey };
  expect(acceptRelayDeviceCert(mobileRelayAuthCrypto, link, { ...accept, cert })).toEqual(cert);
  // 被替换的中转自己签的证书:手机不加入。
  const forged = issueRelayDeviceCert(nodeRelayAuthCrypto, createRelaySigningKey(nodeRelayAuthCrypto).seed, certFields);
  expect(() => acceptRelayDeviceCert(mobileRelayAuthCrypto, link, { ...accept, cert: forged }))
    .toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));

  // 官方中转:不签名。
  expect(currentSelfHostedRelayFrameAuth()).toBeNull();

  // 自建中转:手机签名,电脑(node:crypto)核对。
  setActiveSelfHostedRelay({
    relayId,
    name: 'Home',
    baseUrl: link.baseUrl,
    credential: 'relay-credential',
    signing: { deviceId: phoneId, ownerPublicKey: owner.publicKey, seed: identity.seed },
  });
  const phone = currentSelfHostedRelayFrameAuth()!;
  const computer = new RelayFrameAuthenticator({
    crypto: nodeRelayAuthCrypto,
    relayId,
    deviceId: computerId,
    seed: createRelaySigningKey(nodeRelayAuthCrypto).seed,
    ownerPublicKey: owner.publicKey,
  });
  expect(computer.setCertificates([cert])).toEqual({ accepted: 1, rejected: 0 });

  // 手机发出时没有 src,中转转发时填上。
  const invoke = (args: unknown[]): Envelope => ({
    v: PROTOCOL_VERSION, kind: 'invoke', id: 'req-1', dst: computerId, payload: { channel: 'maker:send', args },
  });
  const delivered = (frame: Envelope) => ({ ...frame, src: phoneId, auth: phone.sign(frame) });
  expect(computer.verify(delivered(invoke(['继续 👋'])))).toBe('ok');
  const tampered = delivered(invoke(['继续 👋']));
  expect(computer.verify({ ...tampered, payload: { channel: 'maker:send', args: ['tampered'] } })).toBe('bad-signature');
});
