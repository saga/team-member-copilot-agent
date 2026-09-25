import { useRef, useState } from 'react';
import { api } from '../lib/api';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

export function Chat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
  };

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const { sessionId: id } = await api.createSession(model.trim() || undefined);
    setSessionId(id);
    return id;
  }

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: prompt }]);
    scrollBottom();

    try {
      const id = await ensureSession();
      const currentModel = model.trim() || undefined;
      if (streaming) {
        let acc = '';
        setMessages((m) => [...m, { role: 'assistant', content: '' }]);
        api.chatStream(
          id,
          prompt,
          {
            onDelta: (d) => {
              acc += d;
              setMessages((m) => {
                const next = [...m];
                next[next.length - 1] = { role: 'assistant', content: acc };
                return next;
              });
              scrollBottom();
            },
            onDone: () => setBusy(false),
            onError: (e) => {
              setError(e.message);
              setBusy(false);
            },
          },
          currentModel,
        );
      } else {
        const { content } = await api.chat(id, prompt, currentModel);
        setMessages((m) => [...m, { role: 'assistant', content }]);
        setBusy(false);
        scrollBottom();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function reset() {
    if (sessionId) {
      try {
        await api.destroySession(sessionId);
      } catch {
        // 销毁失败也不阻塞开新会话
      }
    }
    setSessionId(null);
    setMessages([]);
    setError(null);
  }

  return (
    <div className="chat">
      <div className="toolbar">
        <label>
          Model{' '}
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="留空=服务端默认"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={streaming}
            onChange={(e) => setStreaming(e.target.checked)}
          />{' '}
          流式 (SSE)
        </label>
        <button onClick={() => void reset()} disabled={busy}>
          新会话
        </button>
        {sessionId && <code className="sid">{sessionId.slice(0, 8)}…</code>}
      </div>

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <p className="hint">在下方输入问题，React 会调用 Express 的 /api/sessions/:id/chat。</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role !== 'user' && <b>Copilot</b>}
            <pre>{m.content || (busy ? '▍' : '')}</pre>
          </div>
        ))}
      </div>

      {error && <div className="error">出错：{error}</div>}

      <div className="composer">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
          placeholder="输入 prompt 回车发送…"
          disabled={busy}
        />
        <button onClick={() => void send()} disabled={busy || !input.trim()}>
          {busy ? '思考中…' : '发送'}
        </button>
      </div>
    </div>
  );
}
