/**
 * Team UI 的共享常量与类型。
 */

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

/** 成员在房间里的展示状态。 */
export type MemberStatusKind = 'idle' | 'working' | 'muted';

export interface MemberStatus {
  className: MemberStatusKind;
  label: string;
}

/** 由 TeamChat 提供：把 memberId 映射成 ●idle / ●working / 🔇muted。 */
export type MemberStatusLookup = (memberId: string) => MemberStatus;
