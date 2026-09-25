import { useEffect, useState } from 'react';
import { api, type Member } from '../../lib/api';

interface MemberMemoryProps {
  member: Member;
}

interface Loaded {
  content: string;
  version: string;
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
 *
 * 因为有两个写入方，保存必须带上「我读到的是哪一版」（`version` 是全文的
 * sha256）。不带的话，一次全文覆盖会把 Agent 在我们编辑期间写下的那句
 * 无声吃掉 —— 冲突时服务端返回 409，这里把它翻译成「重新加载」这个动作。
 */
export function MemberMemory({ member }: MemberMemoryProps) {
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState<Loaded>({ content: '', version: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  function fetchMemory(): Promise<Loaded> {
    return api.getMemberMemory(member.id);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConflict(false);
    setSavedAt(null);

    void fetchMemory()
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setLoaded(result);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id]);

  const dirty = content !== loaded.content;

  async function save() {
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      // 服务端会把标题归一化成 `# Long-term Memory`，回读落盘结果而不是
      // 拿本地文本当准 —— 否则下次进来就会看到两个标题。
      const result = await api.replaceMemberMemory(member.id, content, loaded.version);
      setContent(result.content);
      setLoaded(result);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        // 不自动重试：把用户正在编辑的文本丢掉或者直接覆盖都不对。
        // 拉回最新版本作为新的基线，并说清楚发生了什么，由用户决定。
        setConflict(true);
        setError(e instanceof Error ? e.message : String(e));
        try {
          setLoaded(await fetchMemory());
        } catch {
          // 拉不回来也没关系，下次保存仍然会因为版本不符被拦下
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="sidebar-hint">Loading memory…</p>;

  return (
    <div className="member-memory">
      <p className="sidebar-hint">
        这段内容每轮都会注入 {member.name} 的 system prompt。它只属于这个 Member，
        不随 conversation 变化。Agent 干活时也会往这里写 —— 保存时会检查版本，
        不会把它的写入覆盖掉。
      </p>

      <textarea
        className="memory-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        placeholder={'# Long-term Memory\n\n用户喜欢先看风险再看收益。'}
      />

      {error && <div className="error">{error}</div>}
      {conflict && (
        <p className="sidebar-hint">
          上面是你正在编辑的内容，它基于的旧版本已经过期。检查之后可以再点一次
          Save 强制覆盖，或者点 Revert 放弃你的改动。
        </p>
      )}

      <div className="panel-actions">
        <button type="button" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'Saving…' : conflict ? 'Save anyway' : 'Save Memory'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setContent(loaded.content);
            setConflict(false);
            setError(null);
          }}
          disabled={busy || !dirty}
        >
          Revert
        </button>
        {savedAt && !dirty && <span className="sidebar-hint">已保存 {savedAt}</span>}
      </div>
    </div>
  );
}
