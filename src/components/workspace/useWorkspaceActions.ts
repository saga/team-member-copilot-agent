import { useRef } from 'react';
import { api, type ConversationFile, type Member } from '../../lib/api';
import type { Route } from '../../lib/router';
import type { TaskDraft } from '../team/TaskCreator';
import { newRequestId, type WorkspaceData } from './useWorkspaceData';

export interface WorkspaceActionDeps {
  data: WorkspaceData;
  /** Composer 输入框的内容（表单状态归 Workspace，动作只管发出去）。 */
  input: string;
  setInput: (value: string) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  /** 建完工作区后跳转落点（/tasks/:id），由 Workspace 的路由 hook 提供。 */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  /** 这条消息要带的文件（composer 上的 chip）。 */
  selectedFileIds: string[];
  setSelectedFileIds: (ids: string[]) => void;
  setEditingMemberId: (id: string | null) => void;
  setNewTaskOpen: (open: boolean) => void;
  setNewMemberOpen: (open: boolean) => void;
}

/**
 * Workspace 的动作层：建房间 / 发消息 / 归档。
 *
 * 只管「用户想干什么」，不管「现在是什么样」—— 读状态走 data，
 * 写状态走 data 暴露的那几个意图明确的函数（upsertConversation /
 * addMember / appendMessages / applyMemberSaved / openConversation /
 * setNotice），不直接碰任何 setState。
 */
export function useWorkspaceActions(deps: WorkspaceActionDeps) {
  const { data } = deps;

  /**
   * 上一次发送的幂等键。
   *
   * 只在「内容完全相同」时才复用：同一次发送的重试（响应丢了、用户又点了一次
   * Send）应该收敛成一条消息；而用户改了内容再发是一次新的发送，复用旧键会
   * 被服务端当成重试、把新内容默默丢掉。
   */
  const pendingSendRef = useRef<{ clientRequestId: string; content: string } | null>(null);

  /**
   * 新建 Task 工作区：建完直接切过去，用户在输入框里说清楚目标，
   * Lead 会澄清并规划任务、自动开始执行。
   */
  async function createTask(input: TaskDraft) {
    const result = await api.createConversation({
      kind: 'task',
      title: input.title,
      memberIds: input.memberIds,
      leadMemberId: input.leadMemberId,
      externalWorkRef: input.jiraKey ? { provider: 'jira', key: input.jiraKey } : null,
    });    const created = result.conversation;
    data.upsertConversation(created);
    data.openConversation(created.id);
    deps.setNewTaskOpen(false);
    deps.navigate({ view: 'tasks', conversationId: created.id });
    data.setNotice('工作区建好了，Lead 正在看需求，他会先开口：缺信息就直接问，够了就直接列任务开干。');
  }

  async function createMember(input: { name: string; role: string }): Promise<void> {
    const result = await api.createMember({
      name: input.name,
      role: input.role,
      description: '',
      style: 'clear and concise',
    });
    data.addMember(result.member);
    deps.setNewMemberOpen(false);
    // 新建只拿到 name + role，personality / system prompt / model 还是空的。
    // 直接开一个单聊等于让一个空壳人格开始干活，所以先把档案页打开。
    deps.setEditingMemberId(result.member.id);
  }

  async function archiveMember(member: Member): Promise<void> {
    try {
      const result = await api.updateMember(member.id, { status: 'archived' });
      data.applyMemberSaved(result.member);
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 上传一份会话文件。
   *
   * 上传即选：用户刚从本机挑了一个文件，几乎总是紧接着要发一条用到它的消息 ——
   * 让他上传完再去 Shared Files 里「引用」一次，是把同一个意图拆成两步。
   * 文件同时也进了 Shared Files（服务端落盘 + file.created）。
   */
  async function uploadFile(file: File): Promise<void> {
    if (!data.conversationId) return;
    deps.setError(null);
    try {
      const result = await api.uploadConversationFile(data.conversationId, file);
      // 只补不覆盖：这份快照是「请求发出那一刻」的状态，而提取与 file.updated
      // 可能已经先通过 SSE 到了（小文件是同步提取完的）。
      data.noteUploadedFile(result.file);
      deps.setSelectedFileIds([...deps.selectedFileIds, result.file.id]);
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteFile(file: ConversationFile): Promise<void> {
    try {
      await api.deleteConversationFile(file.conversationId, file.id);
      data.removeConversationFile(file.id);
      // 已选中的话也要撤掉：发出去会被服务端拒（文件已被删除）。
      deps.setSelectedFileIds(deps.selectedFileIds.filter((id) => id !== file.id));
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function send() {
    const content = deps.input.trim();
    if (!content || !data.conversationId) return;

    // 同一条内容的重试复用同一个幂等键：双击、或者上一次响应丢了再点一次，
    // 都不会在房间里留下两条一样的消息。
    const pending = pendingSendRef.current;
    const clientRequestId =
      pending && pending.content === content ? pending.clientRequestId : newRequestId();
    pendingSendRef.current = { clientRequestId, content };

    deps.setBusy(true);
    deps.setError(null);
    // 「发第一条消息才会开始」这条提示在消息真的发出去之后就不成立了
    data.setNotice(null);
    const fileIds = [...deps.selectedFileIds];
    deps.setInput('');
    try {
      const result = await api.sendMessage(data.conversationId, {
        content,
        clientRequestId,
        ...(fileIds.length > 0 ? { fileIds } : {}),
      });
      // 发出去了才清掉：失败时保留，好让「再点一次」变成一次真正的重试。
      pendingSendRef.current = null;
      // 附件跟着消息走了，chip 就没用了 —— 留着会让下一条消息莫名其妙又带上它们。
      deps.setSelectedFileIds([]);
      // 202：消息已落库。乐观插入（带附件），SSE 到达时会按 id 去重。
      data.appendMessages([result.message]);
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
      deps.setInput(content);
    } finally {
      deps.setBusy(false);
    }
  }

  async function retryTask(taskId: string): Promise<void> {
    try {
      const result = await api.retryTask(taskId);
      data.applyTaskChanged(result.task);
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function cancelTask(taskId: string): Promise<void> {
    try {
      const result = await api.cancelTask(taskId);
      data.applyTaskChanged(result.task);
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    createTask,
    createMember,
    archiveMember,
    uploadFile,
    deleteFile,
    send,
    retryTask,
    cancelTask,
  };
}
