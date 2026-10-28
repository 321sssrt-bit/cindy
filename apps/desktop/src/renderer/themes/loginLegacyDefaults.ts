import legacy from './loginLegacyDefaults.json';

/**
 * 旧版「导出当前主题」会把当时所有注册色(含 `login-*`)写进本地主题,加载时本地值优先于新默认值,
 * 升级后这些副本的登录页会继续显示旧色(禁用主按钮甚至与可用态几乎相同)。
 *
 * 本函数在加载期把「恰好等于升级前默认值」的 `login-*` override 丢掉,让新默认值生效;用户改过的值
 * 不在对照表内,原样保留。对照表见 `loginLegacyDefaults.json`(历史快照)。只改内存、不改写磁盘、
 * 幂等,没有可迁移项时返回原对象(治理合同 §4)。
 */
const LEGACY_LOGIN_DEFAULTS: Readonly<Record<string, readonly string[]>> = legacy.defaults;

export function dropLegacyLoginDefaults(colors: Record<string, string>): Record<string, string> {
  let next: Record<string, string> | null = null;
  for (const [id, value] of Object.entries(colors)) {
    const old = LEGACY_LOGIN_DEFAULTS[id];
    if (old?.some((v) => v.toLowerCase() === value.trim().toLowerCase())) {
      next ??= { ...colors };
      delete next[id];
    }
  }
  return next ?? colors;
}
