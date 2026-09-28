import type { Member } from './domain.js';

/**
 * User-facing mention 的唯一语法：`@architect`、`@security_reviewer`。
 *
 * MessageComposer 会把选择的 Member 写成 @handle，所以服务端也只认 handle，
 * 不根据 display name 猜测。前面必须是开头或空白 / 常见括号，避免把邮箱、
 * 普通文本里的 @ 当成 mention。
 */
const MEMBER_MENTION_RE = /(?:^|[\s([{\u3000])@([A-Za-z0-9_-]+)/g;

/**
 * 用户消息里明确点名的 Member（按 handle 精确匹配，只认 active 成员）。
 *
 * 这是「普通消息走 Lead、明确 @ 走被点名 Member」分流的唯一判据 ——
 * 解析只做一次、只在这里做，不散落在 TeamService 各处。
 */
export function findMentionedMembers(
  content: string,
  members: readonly Member[],
): Member[] {
  const requestedHandles = new Set<string>();
  for (const match of content.matchAll(MEMBER_MENTION_RE)) {
    const handle = match[1]?.trim().toLowerCase();
    if (handle) requestedHandles.add(handle);
  }
  if (requestedHandles.size === 0) return [];

  const seen = new Set<string>();
  return members.filter((member) => {
    if (member.status !== 'active') return false;
    if (!requestedHandles.has(member.handle.toLowerCase())) return false;
    if (seen.has(member.id)) return false;
    seen.add(member.id);
    return true;
  });
}
