import { useState } from 'react';
import { Alert, Empty, Layout, Space, Tag } from 'antd';
import type { Member } from '../lib/api';
import { ConversationHeader } from './team/ConversationHeader';
import { ConversationMessages } from './team/ConversationMessages';
import { MessageComposer } from './team/MessageComposer';
import { MemberProfile } from './team/MemberProfile';
import { TeamManagement } from './team/TeamManagement';
import { CapabilitySettings } from './team/CapabilitySettings';
import { GroupCreator } from './team/GroupCreator';
import { ConversationSidebar } from './chat/ConversationSidebar';
import { WorkspaceNav, type WorkspaceView } from './workspace/WorkspaceNav';
import { WorkCreator } from './team/WorkCreator';
import { ResizableSider } from './ResizableSider';
import { STATUS_LABEL, useWorkspaceData } from './workspace/useWorkspaceData';
import { useWorkspaceActions } from './workspace/useWorkspaceActions';

const { Content } = Layout;

/**
 * 整个页面的 controller：只做三件事 —— 视图切换、Composer 表单状态、排布。
 *
 * 数据（成员 / 会话 / 消息 / SSE / execution / 房间状态）在 useWorkspaceData 里，
 * 动作（建房间 / 发消息 / 归档）在 useWorkspaceActions 里。这里不直接调 api，
 * 也不持有任何服务端状态。
 *
 * 三个面各管一层，互不掺和：
 *
 *   chat     —— 日常对话（第二列只有会话）
 *   team     —— 成员 / Current Work / Automation
 *   settings —— Capabilities（Admin 面，不在聊天顶栏）
 */
export function Workspace() {
  /** 当前在哪个面：工作面 / 管理面 / 设置面。 */
  const [view, setView] = useState<WorkspaceView>('chat');
  /**
   * 从 Member 行点进 Settings 时的落点（哪一层、哪个人）。
   * CapabilitySettings 只在挂载时读一次，切人时用 key 换 key 强制重挂。
   */
  const [capabilityTarget, setCapabilityTarget] = useState<{
    scope: 'global' | 'team' | 'member';
    memberId: string | null;
  } | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 三个创建窗口互不干扰：各管各的开关。 */
  const [newDiscussionOpen, setNewDiscussionOpen] = useState(false);
  const [newWorkOpen, setNewWorkOpen] = useState(false);
  const [newMemberOpen, setNewMemberOpen] = useState(false);
  /**
   * 正在编辑档案的 Member。
   *
   * 刻意和「进入单聊」分开：member row 上 Chat / Edit 是两个独立动作。
   * 把二者塞进同一个 handler，会让「想改一下它的 system prompt」变成
   * 「顺手开了一个新会话」。
   */
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);

  const data = useWorkspaceData({ onError: setError });
  const actions = useWorkspaceActions({
    data,
    input,
    setInput,
    setBusy,
    setError,
    setView,
    setEditingMemberId,
    setNewDiscussionOpen,
    setNewWorkOpen,
    setNewMemberOpen,
  });

  const {
    members,
    conversations,
    conversationId,
    selectedConversation,
    messages,
    streaming,
    delegations,
    conversationStates,
    recipientMemberId,
    setRecipientMemberId,
    notice,
    setNotice,
    memberById,
    memberLabel,
    activeExecutions,
    memberStatus,
    scrollRef,
    openConversation,
    applyStateChanged,
    applyConversationChanged,
    applyMemberSaved,
  } = data;
  const { createDirect, createGroup, createWork, createMember, archiveMember, send } = actions;

  const editingMember = editingMemberId ? (memberById.get(editingMemberId) ?? null) : null;

  /**
   * 从 Member 行进 Settings：落在「这个人」的增量能力上。
   * Settings 是 Admin 面，入口在管理面和小菜单，不在聊天顶栏。
   */
  function manageMemberCapabilities(member: Member) {
    setCapabilityTarget({ scope: 'member', memberId: member.id });
    setView('settings');
  }

  return (
    <Layout style={{ height: '100%', flexDirection: 'row' }}>
      <WorkspaceNav view={view} onChange={setView} />

      {view === 'chat' && (
        <ResizableSider>
          <ConversationSidebar
            conversations={conversations}
            selectedConversationId={conversationId}
            onSelectConversation={openConversation}
            onNewDiscussion={() => setNewDiscussionOpen(true)}
            onNewWork={() => setNewWorkOpen(true)}
          />
        </ResizableSider>
      )}

      <Layout style={{ minWidth: 0 }}>
        {error && (
          <Alert
            type="error"
            showIcon
            closable
            onClose={() => setError(null)}
            message={error}
            style={{ margin: '8px 18px 0' }}
          />
        )}

        {view === 'team' && (
          <TeamManagement
            members={members}
            conversations={conversations}
            showNewMember={newMemberOpen}
            onToggleNewMember={() => setNewMemberOpen((value) => !value)}
            onCreateMember={createMember}
            onCancelNewMember={() => setNewMemberOpen(false)}
            onChatMember={(member) => void createDirect(member)}
            onViewMember={(member) => setEditingMemberId(member.id)}
            onManageMemberCapabilities={manageMemberCapabilities}
            onArchiveMember={(member) => void archiveMember(member)}
          />
        )}

        {view === 'settings' && (
          <div style={{ padding: '12px 18px', overflowY: 'auto', height: '100%' }}>
            <CapabilitySettings
              key={`${capabilityTarget?.scope ?? 'global'}:${capabilityTarget?.memberId ?? ''}`}
              inline
              initialScope={capabilityTarget?.scope ?? 'global'}
              initialMemberId={capabilityTarget?.memberId ?? null}
              onClose={() => setView('chat')}
            />
          </div>
        )}

        {view === 'chat' && !selectedConversation && (
          <Content style={{ display: 'grid', placeItems: 'center', color: '#999' }}>
            <Empty description="先选择一个 Team Member" />
          </Content>
        )}

        {view === 'chat' && selectedConversation && (
          <Content style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <ConversationHeader
              conversation={selectedConversation}
              allMembers={members}
              states={conversationStates}
              memberStatus={memberStatus}
              onConversationChanged={applyConversationChanged}
              // 子组件只处理单个 state；状态「消失」只有 SSE 会带来，
              // 统一在边界上包成同一种变化对象。
              onStateChanged={(state) =>
                applyStateChanged({ memberId: state.memberId, state })
              }
            />

            {activeExecutions.length > 0 && (
              <Space wrap style={{ padding: '8px 18px 0' }}>
                {activeExecutions.map((execution) => (
                  <Tag
                    key={execution.id}
                    color={execution.status === 'waiting_for_member' ? 'warning' : 'processing'}
                  >
                    {memberLabel(execution.memberId)} · {STATUS_LABEL[execution.status]}
                  </Tag>
                ))}
              </Space>
            )}

            <ConversationMessages
              conversation={selectedConversation}
              messages={messages}
              streaming={streaming}
              delegations={delegations}
              memberLabel={memberLabel}
              scrollRef={scrollRef}
            />

            {notice && (
              <Alert
                type="info"
                showIcon
                closable
                onClose={() => setNotice(null)}
                message={notice}
                style={{ margin: '0 18px' }}
              />
            )}

            <MessageComposer
              conversation={selectedConversation}
              value={input}
              onChange={setInput}
              onSend={() => void send()}
              busy={busy}
              disabled={!conversationId}
              recipientMemberId={recipientMemberId}
              onRecipientChange={setRecipientMemberId}
            />
          </Content>
        )}
      </Layout>

      {editingMember && (
        <MemberProfile
          member={editingMember}
          onSaved={applyMemberSaved}
          onClose={() => setEditingMemberId(null)}
        />
      )}

      <GroupCreator
        open={newDiscussionOpen}
        members={members}
        onCreate={createGroup}
        onCancel={() => setNewDiscussionOpen(false)}
      />

      <WorkCreator
        open={newWorkOpen}
        members={members}
        onCreate={createWork}
        onCancel={() => setNewWorkOpen(false)}
      />
    </Layout>
  );
}
