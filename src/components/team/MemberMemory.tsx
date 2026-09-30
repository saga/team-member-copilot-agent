import { useEffect, useState } from 'react';
import { Alert, Button, Input, Space, Spin } from 'antd';
import { api, type Member } from '../../lib/api';

interface MemberMemoryProps {
  member: Member;
}

interface Loaded {
  content: string;
  version: string;
}

/**
 * Member 长期记忆编辑器（`.data/members/<id>/memory/MEMORY.md`）。
 *
 * 两个写入方：Agent 在 turn 里调 remember_member，人在这里改。每轮都会拼进
 * system prompt（见 buildMemberSystemPrompt 的 `Long-term memory` 段），
 * 所以这里改的是**行为**，不是备注。
 *
 * 因为有两个写入方，保存必须带上「我读到的是哪一版」（`version` 是全文的
 * sha256）。不带的话，一次全文覆盖会把 Agent 在我们编辑期间写下的那句
 * 无声吃掉 —— 冲突时服务端返回 409，这里把它翻译成「重新加载」这个动作。
 */
export function MemberMemory({ member }: MemberMemoryProps) {
  const title = '# Long-term Memory';
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
      // 服务端会把标题归一化，回读落盘结果而不是
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

  if (loading) return <Spin size="small" tip="Loading memory…" />;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <span style={{ color: '#666', fontSize: 13 }}>
        这位成员长期稳定的工作习惯和偏好。它跨团队、跨工作区都生效，系统不会自动改动，
        但成员自己干活时可以用 remember_member 往里记东西。
      </span>

      <Input.TextArea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        rows={14}
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
        placeholder={`${title}\n\n用户喜欢先看风险再看收益。`}
      />

      {error && <Alert type="error" showIcon message={error} />}
      {conflict && (
        <Alert
          type="warning"
          showIcon
          message="你编辑的内容基于的旧版本已过期。检查之后可以再点一次 Save 强制覆盖，或者点 Revert 放弃改动。"
        />
      )}

      <Space>
        <Button type="primary" onClick={() => void save()} disabled={busy || !dirty} loading={busy}>
          {conflict ? 'Save anyway' : 'Save Memory'}
        </Button>
        <Button
          onClick={() => {
            setContent(loaded.content);
            setConflict(false);
            setError(null);
          }}
          disabled={busy || !dirty}
        >
          Revert
        </Button>
        {savedAt && !dirty && <span style={{ color: '#999' }}>已保存 {savedAt}</span>}
      </Space>
    </Space>
  );
}
