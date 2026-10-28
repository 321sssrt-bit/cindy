import legacy from './loginLegacyDefaults.json';
import type { ThemeType } from './types';

/**
 * 旧版「导出当前主题」会把当时所有注册色(含 `login-*`)写进本地主题,加载时本地值优先于新默认值,
 * 升级后这些副本的登录页会继续显示旧色(禁用主按钮甚至与可用态几乎相同)。
 *
 * 本函数在加载期把「恰好等于该主题模式(light / dark)升级前默认值」的 `login-*` override 丢掉,让新
 * 默认值生效;只比对本模式的槽位,所以深色主题里有意用的「历史亮色值」不会被误删,用户改过的值也原样保留。
 * 对照表含两代旧值:10-23 前的文字实色与 10-27 前的面板 / 控件值,否则只迁一半,旧文字色会压在新面板上。对照表见 `loginLegacyDefaults.json`(历史快照)。只改内存、不改写磁盘、
 * 幂等,没有可迁移项时返回原对象(治理合同 §4)。
 */
// JSON 导入只会推成 string[];数据固定为 [light, dark] 二元组,由 localThemesNormalize.test.ts 覆盖。
const LEGACY_LOGIN_DEFAULTS = legacy.defaults as unknown as Readonly<
  Record<string, readonly [light: string, dark: string]>
>;

export function dropLegacyLoginDefaults(
  colors: Record<string, string>,
  type: ThemeType,
): Record<string, string> {
  const slot = type === 'light' ? 0 : 1;
  let next: Record<string, string> | null = null;
  for (const [id, value] of Object.entries(colors)) {
    const old = LEGACY_LOGIN_DEFAULTS[id]?.[slot];
    if (old !== undefined && old.toLowerCase() === value.trim().toLowerCase()) {
      next ??= { ...colors };
      delete next[id];
    }
  }
  return next ?? colors;
}
