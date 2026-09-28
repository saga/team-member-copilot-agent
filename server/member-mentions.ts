import type { Member } from './domain.js';

/**
 * User-facing mention 的唯一语法：
 *
 *   @architect
 *   @security_reviewer
 *
 * MessageComposer 会把选择的 Member 写成 @handle，所以服务端也只认 handle，
 * 不根据 display name 猜测。
 */
const MEMBER_MENTION_RE = /(?:^|[\s([{\u3000])@([A-Za-z0-9_-]+)/g;

/**
 * 返回顺序严格按照用户消息中 @Member 出现的顺序。
 *
 * 例如 `@engineer @security 请分别看看` 返回 [engineer, security]，
 * 而不是按照 conversation roster 排序 —— 同一条消息的多个 @ 是一个
 * 有序 mention chain，先被点名的先回答。
 */
export function findMentionedMembers(
  content: string,
  members: readonly Member[],
): Member[] {
  const memberByHandle = new Map<string, Member>();
  for (const member of members) {
    if (member.status !== 'active') continue;
    memberByHandle.set(member.handle.toLowerCase(), member);
  }

  const result: Member[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(MEMBER_MENTION_RE)) {
    const handle = match[1]?.trim().toLowerCase();
    if (!handle) continue;
    const member = memberByHandle.get(handle);
    if (!member) continue;
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    result.push(member);
  }
  return result;
}
