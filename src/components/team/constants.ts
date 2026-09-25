/**
 * Team UI 的共享常量与类型。
 */
import type { Conversation } from '../../lib/api';

/**
 * 收件人下拉里代表「不点名」的哨兵值。
 *
 * 和后端的约定：`targetMemberId` 不存在 = 这条消息交给 GroupDispatcher 决定
 * 唤醒谁（group 的共享讨论）。传一个具体 memberId 等价于一次 @mention。
 * 用一个空串而不是 `undefined` 是因为 `<select>` 的 value 不接受 undefined。
 */
export const EVERYONE = '';

/** 收件人下拉里 Everyone 的显示文案。 */
export const EVERYONE_LABEL = 'Everyone';

/**
 * 两个 Member 的 direct 房间 = Member 之间的私聊（没有用户参与）。
 *
 * 私聊刻意复用 `direct` kind —— 不动 `conversation.kind` 的 CHECK 约束
 * （SQLite 改不了它，只能重建表，而那张表被 6 张表 FK 引用）。
 * 所以**不能只判断 kind**：「用户 ↔ 单个 Member」的单聊也是 direct，
 * 区分点只有成员数。
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

/** 由 TeamChat 提供：把 memberId 映射成 ●idle / ●working / 🔇muted。 */
export type MemberStatusLookup = (memberId: string) => MemberStatus;
