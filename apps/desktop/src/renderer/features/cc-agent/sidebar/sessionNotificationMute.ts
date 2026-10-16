import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';

const log = createLogger('session-notification-mute');

/**
 * 任务级「消息免打扰」开关（会话右键菜单）。
 *
 * 开了之后这个任务不再产生外向提醒：不发系统通知（toast / 提示音）、不上 Agent
 * 灵动岛、不推手机、不发 IM 消息；任务内的未读与角标照常，任务本身照常跑。
 *
 * 乐观更新 + 失败回滚与置顶同款：先 patchLocal 让侧栏立刻切过去，写库失败再翻回来
 * 并抛出，由调用方决定怎么提示。失败必须回滚——留着一个没落库的「已静音」会让用户
 * 以为不会被打扰，实际照旧。
 */
export async function setSessionNotificationsMuted(session: Session, muted: boolean): Promise<void> {
  const previous = session.notificationsMuted === true;
  sessionsStore.patchLocal(session.id, { notificationsMuted: muted });
  try {
    await sessionService.patchMeta(session.id, { notificationsMuted: muted });
  } catch (error) {
    sessionsStore.patchLocal(session.id, { notificationsMuted: previous });
    log.error('[session notification mute]', error);
    throw error;
  }
}
