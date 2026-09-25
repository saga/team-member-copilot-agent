import type { Conversation, ConversationMemberState, Member } from '../../lib/api';
import { GroupMemberManager } from './GroupMemberManager';
import { EVERYONE, EVERYONE_LABEL, isMemberDm, type MemberStatusLookup } from './constants';

interface ConversationHeaderProps {
  conversation: Conversation;
  /** 全部可用成员，供成员管理面板挑「还没进房间的人」。 */
  allMembers: Member[];
  states: Record<string, ConversationMemberState>;
  memberStatus: MemberStatusLookup;

  /** group：Everyone（空串）或某个成员的 id；direct：房间里那唯一一个成员。 */
  recipientMemberId: string;
  onRecipientChange: (memberId: string) => void;
  onToggleMute: (memberId: string) => void;

  showMembers: boolean;
  onToggleMembers: () => void;
  onConversationChanged: (conversation: Conversation) => void;
  onStateChanged: (state: ConversationMemberState) => void;
}

/**
 * 会话头：成员 chip（含 wakeStatus / muted）+ 收件人选择器 + 成员管理面板。
 *
 * 收件人默认是 Everyone，而不是 `conversation.defaultMemberId` —— 后者是
 * 「这个房间默认归谁」，拿它当 group 的默认收件人会把多成员讨论降级成单人聊天。
 */
export function ConversationHeader({
  conversation,
  allMembers,
  states,
  memberStatus,
  recipientMemberId,
  onRecipientChange,
  onToggleMute,
  showMembers,
  onToggleMembers,
  onConversationChanged,
  onStateChanged,
}: ConversationHeaderProps) {
  const isGroup = conversation.kind === 'group';
  const isDm = isMemberDm(conversation);

  return (
    <>
      <header className="conversation-header">
        <div>
          <h2>{conversation.title}</h2>
          <div className="member-chips">
            {conversation.members.map((member) => {
              const status = memberStatus(member.id);
              const className = `member-chip ${status.className}`;

              // 静音只对 group 有意义：direct / work 的 dispatcher 路径不看
              // muted，点它只会造成「UI 说静音了、其实照样回」的错觉。
              if (!isGroup) {
                return (
                  <span key={member.id} className={className}>
                    <span className="member-chip-status">{status.label}</span>
                    @{member.handle}
                  </span>
                );
              }

              return (
                <button
                  key={member.id}
                  type="button"
                  className={className}
                  onClick={() => onToggleMute(member.id)}
                  title={`${member.name} · ${status.label}（点击${
                    status.className === 'muted' ? '取消静音' : '静音'
                  }）`}
                >
                  <span className="member-chip-status">{status.label}</span>
                  @{member.handle}
                </button>
              );
            })}
          </div>
        </div>

        <div className="header-actions">
          {isGroup && (
            <button type="button" className="ghost" onClick={onToggleMembers}>
              Members
            </button>
          )}

          {isGroup ? (
            <select
              className="recipient-select"
              value={recipientMemberId}
              onChange={(e) => onRecipientChange(e.target.value)}
              aria-label="选择这条消息的收件人"
            >
              <option value={EVERYONE}>{EVERYONE_LABEL}</option>
              {conversation.members
                .filter((member) => member.status === 'active')
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    @{member.handle}
                  </option>
                ))}
            </select>
          ) : isDm ? (
            // 私聊房间的用户是旁观者，写「To Alice」会让人以为自己在跟 Alice 说话
            <span className="recipient-static">
              {conversation.members.map((member) => member.name).join(' ↔ ')}
            </span>
          ) : (
            <span className="recipient-static">
              {conversation.members[0] ? `To ${conversation.members[0].name}` : 'No member'}
            </span>
          )}
        </div>
      </header>

      {showMembers && isGroup && (
        <GroupMemberManager
          conversation={conversation}
          allMembers={allMembers}
          states={states}
          onConversationChanged={onConversationChanged}
          onStateChanged={onStateChanged}
          onClose={onToggleMembers}
        />
      )}
    </>
  );
}
