import { CopilotClient, type CopilotSession } from '@github/copilot-sdk';
import { config } from './config.js';

/**
 * Copilot 运行时的唯一收口（基础框架版：内存会话 + 懒加载 client）。
 *
 * - Express 启动时不建连，首次会话操作 / 预热时才连（/api/health 的 copilot 字段
 *   因此有 connected | idle | error 三态，idle 不是故障）。
 * - 每个前端会话对应一个 CopilotSession，内存 Map 管理；要做持久化/多副本时
 *   在这里换实现即可，路由层不用动。
 */
class CopilotService {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  private sessions = new Map<string, CopilotSession>();
  private lastError: string | null = null;
  /** 同一 session 的 turn 串行化：Copilot session 一次只能跑一个 turn。 */
  private locks = new Map<string, Promise<unknown>>();

  async getClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const client = new CopilotClient({
        // 未提供 token 时默认使用 copilot CLI 已登录用户
        ...(config.githubToken
          ? { gitHubToken: config.githubToken, useLoggedInUser: false }
          : { useLoggedInUser: true }),
      });
      await client.start();
      this.client = client;
      this.lastError = null;
      this.starting = null;
      return client;
    })().catch((err) => {
      this.starting = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    });
    return this.starting;
  }

  /** connected = 已建连；idle = 尚未建连（懒加载）；error = 建连失败。 */
  getStatus(): 'connected' | 'idle' | 'error' {
    if (this.client) return 'connected';
    if (this.lastError) return 'error';
    return 'idle';
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** 启动时后台预热（失败不抛，由 /api/health 暴露原因）。 */
  async warmup(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getClient();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async createSession(model?: string): Promise<CopilotSession> {
    const client = await this.getClient();
    const session = await client.createSession({
      ...(model || config.defaultModel ? { model: model ?? config.defaultModel } : {}),
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  getSession(id: string): CopilotSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  async destroySession(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      const session = this.sessions.get(id);
      if (!session) return false;
      try {
        await session.disconnect();
      } catch {
        // disconnect 失败也从本地摘掉，避免僵尸条目
      }
      this.sessions.delete(id);
      return true;
    });
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const cur = prev.finally(() => new Promise<void>((r) => (release = r)));
    this.locks.set(id, cur);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === cur) this.locks.delete(id);
    }
  }

  /**
   * 跑一轮 agent turn。非流式直接返回全文；流式时 onDelta 实时回调增量，
   * 内部统一走 sendAndWait + 事件监听，调用方只关心回调。
   */
  async chat(
    id: string,
    prompt: string,
    opts?: { model?: string; onDelta?: (delta: string) => void },
  ): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error(`session 不存在：${id}`), { status: 404 });
    return this.withLock(id, async () => {
      let content = '';
      const offDelta = session.on('assistant.message_delta', (evt) => {
        const delta = (evt as unknown as { data?: { deltaContent?: string } }).data?.deltaContent;
        if (delta) {
          content += delta;
          opts?.onDelta?.(delta);
        }
      });
      const offMsg = session.on('assistant.message', (evt) => {
        const full = (evt as unknown as { data?: { content?: string } }).data?.content;
        // 某些后端只发全量 message 不发 delta：用全量兜底，避免流式无输出
        if (full && !content) {
          opts?.onDelta?.(full);
        }
      });
      try {
        if (opts?.model) await session.setModel(opts.model);
        const finalEvent = await session.sendAndWait({ prompt });
        const finalContent =
          (finalEvent as unknown as { data?: { content?: string } } | undefined)?.data?.content ??
          '';
        return finalContent || content;
      } finally {
        offDelta();
        offMsg();
      }
    });
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        // 关闭失败忽略，进程仍要退出
      }
      this.client = null;
    }
  }
}

export const copilotService = new CopilotService();
