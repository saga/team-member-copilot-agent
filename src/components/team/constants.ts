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

/** 工作区状态的中文展示：内部状态名不直接进 UI。 */
export const CONVERSATION_STATUS_TEXT: Record<string, string> = {
  intake: '准备中',
  waiting_user: '等你回答',
  running: '执行中',
  blocked: '受阻',
  completed: '已完成',
  cancelled: '已取消',
};

/**
 * 状态的完整人话：发生了什么 + 你要干什么。
 *
 * 只给"等待补充"四个字等于没说 —— 补什么、在哪答、答了会怎样，
 * 一句话里必须都有。
 */
export function describeConversationStatus(conversation: {
  status: string;
  taskProgress: { total: number; completed: number };
  openQuestions: string[];
}): string {
  const { total, completed } = conversation.taskProgress;
  switch (conversation.status) {
    case 'intake':
      return '刚建好，在下面的输入框说清楚要达成什么，Lead 就会开始干活。';
    case 'waiting_user': {
      const [first] = conversation.openQuestions;
      if (first) {
        const more =
          conversation.openQuestions.length > 1
            ? `（共 ${conversation.openQuestions.length} 个，去右侧看“等你回答”）`
            : '（去右侧看“等你回答”）';
        return `Lead 在等你回答：${first}${more} —— 答了就自动继续。`;
      }
      return 'Lead 在等你补充信息，在下面直接回复，答了就自动继续。';
    }
    case 'running':
      return total > 0
        ? `正在执行（${completed}/${total} 个任务完成），不用管，跑完会停在“已完成”。`
        : 'Lead 正在看需求、规划任务，稍等。';
    case 'blocked':
      return '有任务卡住了，看右侧红色标注里写的缺什么，在下面补上信息就会自动继续。';
    case 'completed':
      return '全部任务做完了。要做新事情请新建一个工作区，这里不再收消息。';
    case 'cancelled':
      return '已经取消，不再推进。要做事请新建一个工作区。';
    default:
      return '';
  }
}

/** Task 状态的中文展示。 */
export const TASK_STATUS_TEXT: Record<string, string> = {
  pending: '等待依赖',
  ready: '待开始',
  running: '执行中',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
