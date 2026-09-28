import { useEffect, useRef, useState } from 'react';
import { Alert, Empty, Layout } from 'antd';
import type { Member } from '../lib/api';
import { useRoute } from '../lib/router';
import { ConversationHeader } from './team/ConversationHeader';
import { ActivityFeed } from './team/ActivityFeed';
import { TaskPanel } from './team/TaskPanel';
import { ConversationFilesDrawer } from './team/ConversationFilesDrawer';
import { ConversationFilePicker } from './team/ConversationFilePicker';
import { MessageComposer } from './team/MessageComposer';
import { MemberProfile } from './team/MemberProfile';
import { TeamManagement } from './team/TeamManagement';
import { SettingsPage } from './team/SettingsPage';
import { TaskSidebar } from './tasks/TaskSidebar';
import { WorkspaceNav } from './workspace/WorkspaceNav';
import { TaskCreator } from './team/TaskCreator';
import { ResizableSider } from './ResizableSider';
import { useModelPolicy } from './team/useModelPolicy';
import { useWorkspaceData } from './workspace/useWorkspaceData';
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
 *   tasks    —— Task 工作区（第二列只有工作区列表）
 *   team     —— 成员 / Current Work / Automation
 *   settings —— Capabilities（Admin 面，不在工作区顶栏）
 */
export function Workspace() {
  /**
   * 视图与关键上下文都在 URL 里（见 lib/router.ts）：切面 / 切会话 / 切配置对象
   * 都会改变地址，刷新和深链能还原现场，浏览器前进后退可用。
   */
  const [route, navigate] = useRoute();
  const view = route.view;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 创建窗口的开关。 */
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newMemberOpen, setNewMemberOpen] = useState(false);
  /**
   * 正在编辑档案的 Member。
   *
   * 刻意和「进入工作区」分开：member row 上 New task / Edit 是两个独立动作。
   * 把二者塞进同一个 handler，会让「想改一下它的 system prompt」变成
   * 「顺手开了一个新会话」。编辑是瞬态模态，不进 URL。
   */
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  /**
   * 下一条消息要带的文件（composer 上的 chip）。
   *
   * 存 id 而不是文件对象：文件列表会随着 SSE 更新（处理中就绪、被删掉），
   * 存对象的话 chip 上显示的是那一刻的快照。发送后清空 —— chip 是「这条消息
   * 的上下文」，不是「这个会话的上下文」。
   */
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  /** 首载默认落点只决定一次，标记防止后续路由变化重新触发。 */
  const bootstrappedRef = useRef(false);

  const data = useWorkspaceData({ onError: setError });
  const actions = useWorkspaceActions({
    data,
    input,
    setInput,
    setBusy,
    setError,
    navigate,
    selectedFileIds,
    setSelectedFileIds,
    setEditingMemberId,
    setNewTaskOpen,
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
    mcpUsage,
    conversationStates,
    conversationFiles,
    tasks,
    applyTaskChanged,
    notice,
    setNotice,
    memberById,
    memberLabel,
    memberStatus,
    scrollRef,
    openConversation,
    applyStateChanged,
    applyConversationChanged,
    applyMemberSaved,
  } = data;
  void applyTaskChanged;
  const { createTask, createMember, archiveMember, send, uploadFile, deleteFile, retryTask, cancelTask } =
    actions;

  const editingMember = editingMemberId ? (memberById.get(editingMemberId) ?? null) : null;
  /** 服务端模型策略：Task 创建窗口与 Member 档案共用一份。 */
  const modelPolicy = useModelPolicy();

  /**
   * composer 上真正显示的文件。
   *
   * 从 id 反查当前列表，而不是直接拿上传那一刻的对象：文件可能在两次渲染之间
   * 变成 processing → ready，也可能被删掉（那就该从 chip 上消失，而不是留一个
   * 发不出去的附件让用户猜为什么失败）。
   */
  const selectedFiles = selectedFileIds
    .map((id) => conversationFiles.find((file) => file.id === id))
    .filter((file): file is NonNullable<typeof file> => Boolean(file));

  /** 切换会话时清空选中：chip 属于上一个房间的消息。 */
  useEffect(() => {
    setSelectedFileIds([]);
    setFilesDrawerOpen(false);
    setFilePickerOpen(false);
  }, [conversationId]);

  // URL → data：跟随路由切会话。等会话列表到位后再动作 —— 深链直进时路由
  // 先到、roster 后到，提前打开没有意义。路由指明的会话不存在（过期链接）就
  // 停在空态，不报错也不瞎猜一个会话。
  useEffect(() => {
    if (route.view !== 'tasks' || conversations.length === 0) return;
    if (route.conversationId && !conversations.some((item) => item.id === route.conversationId)) {
      return;
    }
    if (route.conversationId !== conversationId) {
      openConversation(route.conversationId);
    }
  }, [route, conversations, conversationId, openConversation]);

  // 默认落点：首次加载时 URL 没指明工作区（/ 或 /tasks），自动落到第一个工作区并把
  // 地址补全（replace，不塞历史）。只做这一次，之后选会话永远是用户说了算。
  useEffect(() => {
    if (bootstrappedRef.current || view !== 'tasks' || conversations.length === 0) return;
    bootstrappedRef.current = true;
    if (!route.conversationId) {
      navigate({ view: 'tasks', conversationId: conversations[0].id }, { replace: true });
    }
  }, [view, route, conversations, navigate]);

  /** 用户点侧栏切会话：立即打开并写入历史（后退可以回到上一个会话）。 */
  function selectConversation(id: string) {
    openConversation(id);
    navigate({ view: 'tasks', conversationId: id });
  }

  /**
   * 从 Member 行进 Settings：落在「这个人」的增量能力上。
   * Settings 是 Admin 面，入口在管理面和小菜单，不在工作区顶栏。
   */
  function manageMemberCapabilities(member: Member) {
    navigate({ view: 'settings', section: 'capabilities', scope: 'member', memberId: member.id });
  }

  return (
    <Layout style={{ height: '100%', flexDirection: 'row' }}>
      <WorkspaceNav
        view={view}
        onChange={(next) => {
          if (next === 'tasks') {
            navigate({ view: 'tasks', conversationId });
          } else if (next === 'team') {
            navigate({ view: 'team' });
          } else {
            navigate({ view: 'settings', section: 'capabilities', scope: 'global', memberId: null });
          }
        }}
      />

      {view === 'tasks' && (
        <ResizableSider>
          <TaskSidebar
            conversations={conversations}
            selectedConversationId={conversationId}
            onSelectConversation={selectConversation}
            onNewTask={() => setNewTaskOpen(true)}
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
            onNewTaskWithMember={(member) =>
              void createTask({
                title: `${member.name} 的工作区`,
                memberIds: [member.id],
                leadMemberId: member.id,
                jiraKey: '',
              })
            }
            onViewMember={(member) => setEditingMemberId(member.id)}
            onManageMemberCapabilities={manageMemberCapabilities}
            onArchiveMember={(member) => void archiveMember(member)}
          />
        )}

        {view === 'settings' && <SettingsPage route={route} navigate={navigate} />}

        {view === 'tasks' && !selectedConversation && (
          <Content style={{ display: 'grid', placeItems: 'center', color: '#999' }}>
            <Empty description="先在左边选一个工作区，没有就新建一个" />
          </Content>
        )}

        {view === 'tasks' && selectedConversation && (
          <Content className="task-workspace">
            <ConversationHeader
              conversation={selectedConversation}
              allMembers={members}
              states={conversationStates}
              memberStatus={memberStatus}
              memberLabel={memberLabel}
              fileCount={conversationFiles.length}
              onOpenFiles={() => setFilesDrawerOpen(true)}
              onConversationChanged={applyConversationChanged}
              // 子组件只处理单个 state；状态「消失」只有 SSE 会带来，
              // 统一在边界上包成同一种变化对象。
              onStateChanged={(state) =>
                applyStateChanged({ memberId: state.memberId, state })
              }
            />

            <div className="task-workspace-body">
              <main className="task-workspace-main">
                <div className="activity-scroll">
                  <div className="activity-content">
                    <ActivityFeed
                      conversation={selectedConversation}
                      messages={messages}
                      streaming={streaming}
                      delegations={delegations}
                      mcpUsage={mcpUsage}
                      memberLabel={memberLabel}
                      taskLabel={(taskId) =>
                        taskId
                          ? (tasks.find((task) => task.id === taskId)?.title ?? null)
                          : null
                      }
                      scrollRef={scrollRef}
                    />
                  </div>
                </div>

                {notice && (
                  <div className="task-notice">
                    <Alert
                      type="info"
                      showIcon
                      closable
                      onClose={() => setNotice(null)}
                      message={notice}
                    />
                  </div>
                )}

                <div className="task-composer">
                  <MessageComposer
                    conversation={selectedConversation}
                    value={input}
                    onChange={setInput}
                    onSend={() => void send()}
                    busy={busy}
                    disabled={!conversationId}
                    selectedFiles={selectedFiles}
                    onRemoveFile={(fileId) =>
                      setSelectedFileIds((current) => current.filter((id) => id !== fileId))
                    }
                    onUploadFile={(file) => void uploadFile(file)}
                    onOpenFilePicker={() => setFilePickerOpen(true)}
                  />
                </div>
              </main>

              {selectedConversation.kind === 'task' && (
                <aside className="task-inspector">
                  <TaskPanel
                    conversation={selectedConversation}
                    tasks={tasks.filter((task) => task.conversationId === selectedConversation.id)}
                    memberLabel={memberLabel}
                    onRetryTask={(taskId) => void retryTask(taskId)}
                    onCancelTask={(taskId) => void cancelTask(taskId)}
                  />
                </aside>
              )}
            </div>
          </Content>
        )}
      </Layout>

      {editingMember && (
        <MemberProfile
          member={editingMember}
          modelPolicy={modelPolicy}
          onSaved={applyMemberSaved}
          onClose={() => setEditingMemberId(null)}
        />
      )}

      <TaskCreator
        open={newTaskOpen}
        members={members}
        leadModels={
          modelPolicy ? { standard: modelPolicy.lead.standard.id, strong: modelPolicy.lead.strong.id } : null
        }
        onCreate={createTask}
        onCancel={() => setNewTaskOpen(false)}
      />

      {selectedConversation && (
        <ConversationFilesDrawer
          open={filesDrawerOpen}
          conversationId={selectedConversation.id}
          files={conversationFiles}
          busy={busy}
          onAttachFile={(file) => {
            if (!selectedFileIds.includes(file.id)) {
              setSelectedFileIds((current) => [...current, file.id]);
            }
            // 引用之后把抽屉收起来：下一步是打字，抽屉挡着消息列表反而碍事。
            setFilesDrawerOpen(false);
          }}
          onUpload={(file) => void uploadFile(file)}
          onDelete={(file) => void deleteFile(file)}
          onClose={() => setFilesDrawerOpen(false)}
        />
      )}

      {selectedConversation && (
        <ConversationFilePicker
          open={filePickerOpen}
          files={conversationFiles}
          selectedIds={selectedFileIds}
          busy={busy}
          onSelect={(file) => {
            if (!selectedFileIds.includes(file.id)) {
              setSelectedFileIds((current) => [...current, file.id]);
            }
          }}
          onUpload={(file) => void uploadFile(file)}
          onClose={() => setFilePickerOpen(false)}
        />
      )}
    </Layout>
  );
}
