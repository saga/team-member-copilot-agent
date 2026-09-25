import { useEffect, useState } from 'react';
import { api, type Member } from '../../lib/api';

interface MemberMemoryProps {
  member: Member;
}

/**
 * Member 的长期记忆。
 *
 * 存的是 `.data/members/<id>/memory/MEMORY.md`，两个入口写它：
 *
 *   remember_member  tool —— Agent 自己在干活时记下的
 *   这个页面              —— 人直接改的
 *
 * 它每轮都会被拼进 system prompt（见 buildMemberSystemPrompt 的
 * `Long-term memory:` 段），所以这里改的是**行为**，不是备注。
 */
export function MemberMemory({ member }: MemberMemoryProps) {
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSavedAt(null);

    void api
      .getMemberMemory(member.id)
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setLoaded(result.content);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [member.id]);

  const dirty = content !== loaded;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // 服务端会把标题归一化成 `# Long-term Memory`，回读落盘结果而不是
      // 拿本地文本当准 —— 否则下次进来就会看到两个标题。
      const result = await api.replaceMemberMemory(member.id, content);
      setContent(result.content);
      setLoaded(result.content);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="sidebar-hint">Loading memory…</p>;

  return (
    <div className="member-memory">
      <p className="sidebar-hint">
        这段内容每轮都会注入 {member.name} 的 system prompt。它只属于这个 Member，
        不随 conversation 变化。
      </p>

      <textarea
        className="memory-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        placeholder={'# Long-term Memory\n\n用户喜欢先看风险再看收益。'}
      />

      {error && <div className="error">{error}</div>}

      <div className="panel-actions">
        <button type="button" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save Memory'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setContent(loaded)}
          disabled={busy || !dirty}
        >
          Revert
        </button>
        {savedAt && !dirty && <span className="sidebar-hint">已保存 {savedAt}</span>}
      </div>
    </div>
  );
}
