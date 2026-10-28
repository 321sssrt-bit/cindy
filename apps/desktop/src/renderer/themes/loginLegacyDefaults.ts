import legacy from './loginLegacyDefaults.json';
import type { ThemeType } from './types';

/**
 * 旧版「导出当前主题」会把当时所有注册色(含 `login-*`)写进本地主题,加载时本地值优先于新默认值,
 * 升级后这些副本的登录页会继续显示旧色(例如旧面板色与新文字色叠在一起、禁用主按钮与可用态几乎相同)。
 *
 * 本函数在加载期把「等于该主题模式历史默认值」的 `login-*` override 丢掉,让当前默认值生效:
 * - 对照表 `loginLegacyDefaults.json` 含冻结快照历史里每个 token 出现过的全部旧值,不逐代手补;
 * - 只比对本模式的槽位,深色主题里有意使用的「历史亮色值」不会被误删,用户自改的值也保留;
 * - 只处理完整导出快照(含至少 {@link FULL_EXPORT_MIN_LOGIN_KEYS} 个 `login-*` 键):导出会写入全部登录色,
 *   而手写的稀疏主题只有零星几个,它们有意固定的值(哪怕恰好等于历史值)原样保留;
 * - 只改内存、不改写磁盘、幂等,没有可迁移项时返回原对象(治理合同 §4)。
 */
type Slots = Readonly<{ light: readonly string[]; dark: readonly string[] }>;
const LEGACY_LOGIN_DEFAULTS = legacy.defaults as Readonly<Record<string, Slots>>;

/** 旧版导出会写入全部登录色(30+ 个);达到这个数才视为完整导出快照。 */
export const FULL_EXPORT_MIN_LOGIN_KEYS = 20;

/** 比较前归一化:去空白、转小写,rgba 里的数字写法统一(`0.1` 与 `0.10`)。 */
function canonical(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s+/g, '');
  return v.startsWith('rgb') ? v.replace(/\d*\.?\d+/g, (n) => String(Number(n))) : v;
}

export function dropLegacyLoginDefaults(
  colors: Record<string, string>,
  type: ThemeType,
): Record<string, string> {
  const loginKeys = Object.keys(colors).filter((id) => id.startsWith('login-'));
  if (loginKeys.length < FULL_EXPORT_MIN_LOGIN_KEYS) return colors;
  let next: Record<string, string> | null = null;
  for (const id of loginKeys) {
    const value = canonical(colors[id] ?? '');
    if (LEGACY_LOGIN_DEFAULTS[id]?.[type].some((old) => canonical(old) === value)) {
      next ??= { ...colors };
      delete next[id];
    }
  }
  return next ?? colors;
}
