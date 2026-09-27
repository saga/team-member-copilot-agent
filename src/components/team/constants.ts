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
