const API_BASE = import.meta.env.VITE_API_BASE || '';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface Health {
  status: string;
  uptime: number;
  timestamp: string;
  /** idle = client 尚未建连的懒加载态，不是故障 */
  copilot: 'connected' | 'idle' | 'error';
  copilotError?: string;
}

export const api = {
  health(): Promise<Health> {
    return fetch(`${API_BASE}/api/health`).then(json<Health>);
  },

  createSession(model?: string): Promise<{ sessionId: string }> {
    return fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    }).then(json<{ sessionId: string }>);
  },

  listSessions(): Promise<{ sessions: string[] }> {
    return fetch(`${API_BASE}/api/sessions`).then(json<{ sessions: string[] }>);
  },

  destroySession(id: string): Promise<unknown> {
    return fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then(json<unknown>);
  },

  /** 非流式：一问一答 */
  chat(sessionId: string, prompt: string, model?: string): Promise<{ content: string }> {
    return fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, streaming: false, model }),
    }).then(json<{ content: string }>);
  },

  /**
   * 流式：SSE，回调 onDelta 增量更新。
   * 后端事件：delta {delta} / message {content} / done / error
   */
  chatStream(
    sessionId: string,
    prompt: string,
    callbacks: {
      onDelta: (d: string) => void;
      onDone?: () => void;
      onError?: (e: Error) => void;
    },
    model?: string,
  ): void {
    fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, streaming: true, model }),
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => res.statusText);
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        const dispatch = (raw: string) => {
          const frames = raw.split('\n\n');
          for (const frame of frames.slice(0, -1)) {
            const eventMatch = frame.match(/^event:\s*(.+)$/m);
            const dataMatch = frame.match(/^data:\s*(.+)$/m);
            if (!eventMatch || !dataMatch) continue;
            const event = eventMatch[1].trim();
            let data: { delta?: string; content?: string; error?: string };
            try {
              data = JSON.parse(dataMatch[1]);
            } catch {
              continue;
            }
            if (event === 'delta' && data.delta) callbacks.onDelta(data.delta);
            if (event === 'message' && data.content) callbacks.onDelta(data.content);
            if (event === 'done') callbacks.onDone?.();
            if (event === 'error') callbacks.onError?.(new Error(data.error ?? 'stream error'));
          }
          return frames[frames.length - 1];
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          buf = dispatch(buf);
        }
        dispatch(buf + '\n\n');
        callbacks.onDone?.();
      })
      .catch((e: unknown) => callbacks.onError?.(e instanceof Error ? e : new Error(String(e))));
  },
};
