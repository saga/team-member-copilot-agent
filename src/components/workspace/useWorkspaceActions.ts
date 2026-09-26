import { useRef } from 'react';
import { api, type Member } from '../../lib/api';
import type { WorkDraft } from '../team/WorkCreator';
import type { WorkspaceView } from './WorkspaceNav';
import { newRequestId, type WorkspaceData } from './useWorkspaceData';

export interface WorkspaceActionDeps {
  data: WorkspaceData;
  /** Composer 输入框的内容（表单状态归 Workspace，动作只管发出去）。 */
  input: string;
  setInput: (value: string) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setView: (view: WorkspaceView) => void;
  setEditingMemberId: (id: string | null) => void;
  setNewDiscussionOpen: (open: boolean) => void;
  setNewWorkOpen: (open: boolean) => void;
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

  async function createDirect(member: Member) {
    // 必须限定「房间里只有这一个 Member」：Member 之间的私聊同样是 kind='direct'，
    // 只看 kind 的话，点 Alice 的 [Chat] 会一头撞进 Alice 和 Bob 的私聊。
    const existing = data.conversations.find(
      (item) =>
        item.kind === 'direct' &&
        item.members.length === 1 &&
        item.members[0].id === member.id,
    );
    if (existing) {
      data.openConversation(existing.id);
      deps.setView('chat');
      return;
    }

    const result = await api.createConversation({
      kind: 'direct',
      title: member.name,
      memberIds: [member.id],
    });
    data.upsertConversation(result.conversation);
    data.openConversation(result.conversation.id);
    deps.setView('chat');
  }

  /**
   * 新建 Discussion（临时多人协作房间，不是 Team）。
   * 收件人集合是全部成员，由服务端 GroupDispatcher 按 @mention / everyone
   * 规则决定每一轮唤醒谁。
   */
  async function createGroup(input: { title: string; memberIds: string[] }) {
    const result = await api.createConversation({
      kind: 'group',
      title: input.title,
      memberIds: input.memberIds,
    });
    data.upsertConversation(result.conversation);
    deps.setNewDiscussionOpen(false);
    data.openConversation(result.conversation.id);
    deps.setView('chat');
  }

  /**
   * 新建 Work：建房间 + （可选）立刻下第一条指令。
   *
   * 顺序是「先建 → 再切过去 → 再发消息」，不是「先建 → 先发 → 再切」。
   * 切房间会触发打开会话的 effect，那个 effect 会清掉 error / notice；
   * 把发消息放在切之后，才能保证发送失败的提示**不会**被那次清理吃掉。
   * 这也顺带让房间立刻出现在界面上，而不是等消息发完才跳过去。
   *
   * 只建房间是合法用法（比如先开会话、晚点再下指令），但那时这个 Member 没有
   * 任何 execution，Current Work 会是空的 —— 这正好是最容易被误解成 bug 的地方，
   * 所以这里用一条 notice 把它说清楚，而不是让人对着空面板猜。
   */
  async function createWork(input: WorkDraft) {
    const result = await api.createConversation({
      kind: 'work',
      title: input.title,
      // work conversation 只允许恰好一个成员（服务端 assertConversationKindShape）
      memberIds: [input.memberId],
      externalWorkRef: input.jiraKey ? { provider: 'jira', key: input.jiraKey } : null,
    });
    const created = result.conversation;
    data.upsertConversation(created);
    data.openConversation(created.id);
    deps.setNewWorkOpen(false);

    if (!input.instruction) {
      data.setNotice(
        'Work 房间建好了，但还没有下指令 —— 这个 Member 没有开始执行，Current Work 里暂时看不到它。在下面发第一条消息就会开始。',
      );
      return;
    }

    try {
      const sent = await api.sendMessage(created.id, {
        content: input.instruction,
        // 房间里只有它一个；显式点名是为了让「这条指令给谁」不依赖 roster 顺序
        targetMemberId: input.memberId,
        clientRequestId: newRequestId(),
      });
      // 必须乐观插入：房间是先切过去的，那条 GET /messages 在发消息**之前**就
      // 返回了（当时房间里还没有消息）。不插的话，用户得等 SSE 或下次刷新才能
      // 看见自己刚下的指令 —— 而这条指令正是他刚刚亲手打的字。
      data.appendMessages([sent.message]);
    } catch (e) {
      // 房间已经建好了，别把它一起丢掉：把指令放回输入框，重发一次即可
      deps.setInput(input.instruction);
      deps.setError(
        `Work 房间已建好，但第一条指令没有发出去：${
          e instanceof Error ? e.message : String(e)
        }。指令已放回输入框，再点一次 Send 就行。`,
      );
    }
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
    deps.setInput('');
    try {
      const result = await api.sendMessage(data.conversationId, {
        content,
        // Everyone（''）必须传 undefined：让服务端 GroupDispatcher 决定唤醒谁。
        // 传一个具体 memberId = 点名，等价于一次 @mention。
        targetMemberId: data.recipientMemberId || undefined,
        clientRequestId,
      });
      // 发出去了才清掉：失败时保留，好让「再点一次」变成一次真正的重试。
      pendingSendRef.current = null;
      // 202：消息已落库。乐观插入，SSE 到达时会按 id 去重。
      data.appendMessages([result.message]);

      // 部分 @ 没认领：要分清「谁都没收到」和「认领的收到了、只有这几个没匹配到」。
      // 之前这里不分情况一律说「消息没有派给任何人」—— @architect @nobody 发出去，
      // Architect 明明被唤醒了，用户却被告知谁都没收到。
      if (result.unresolvedMentions.length > 0) {
        const names = result.unresolvedMentions.map((mention) => `@${mention}`).join(' ');
        deps.setError(
          result.wakes.length > 0
            ? `以下成员没有匹配到：${names}。已匹配的成员仍会收到消息。`
            : `没有匹配到这些成员：${names}。消息没有派给任何人。`,
        );
      }
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
      deps.setInput(content);
    } finally {
      deps.setBusy(false);
    }
  }

  return { createDirect, createGroup, createWork, createMember, archiveMember, send };
}
