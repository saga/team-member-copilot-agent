/**
 * Team UI 的共享常量与类型。
 */
import type { Conversation } from '../../lib/api';

/**
 * direct 房间 = Member 之间的私聊（没有用户参与），必须恰好两个人。
 *
 * 用户的工作统一走 Task 工作区，不再有用户 ↔ 单个 Member 的单聊房间。
 */
export function isMemberDm(conversation: Conversation): boolean {
  return conversation.kind === 'direct' && conversation.members.length === 2;
}

/** 成员在房间里的展示状态。 */
export type MemberStatusKind = 'idle' | 'working' | 'muted';
export interface MemberStatus {
  className: MemberStatusKind;
  label: string;
}

/** 由 Workspace 提供：把 memberId 映射成 ●idle / ●working / 🔇muted。 */
export type MemberStatusLookup = (memberId: string) => MemberStatus;

/** 工作区状态的中文展示：内部状态名不直接进 UI。 */
export const CONVERSATION_STATUS_TEXT: Record<string, string> = {
  intake: '准备中',
  waiting_user: '等待补充',
  running: '执行中',
  blocked: '受阻',
  completed: '已完成',
  cancelled: '已取消',
};

/** Task 状态的中文展示。 */
export const TASK_STATUS_TEXT: Record<string, string> = {
  pending: '等待依赖',
  ready: '待开始',
  running: '执行中',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
