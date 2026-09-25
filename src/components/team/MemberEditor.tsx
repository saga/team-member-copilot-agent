import { useState } from 'react';
import { api, type Member } from '../../lib/api';

interface MemberEditorProps {
  member: Member;
  onSaved: (member: Member) => void;
  onCancel: () => void;
}

/**
 * Member 身份编辑器。
 *
 * 字段和数据库一一对应，不做二次抽象：
 *
 *   name / handle / role / description / style / systemPrompt / model / toolProfile
 *
 * 这些字段最后会拼进 system prompt（见 TeamService.buildMemberSystemPrompt），
 * 所以它们是**人格定义**，不是元数据装饰。`model` 支持留空 = 显式回落
 * COPILOT_MODEL，所以提交时要用 null 而不是空串。
 */
export function MemberEditor({ member, onSaved, onCancel }: MemberEditorProps) {
  const [name, setName] = useState(member.name);
  const [handle, setHandle] = useState(member.handle);
  const [role, setRole] = useState(member.role);
  const [description, setDescription] = useState(member.description);
  const [style, setStyle] = useState(member.style);
  const [systemPrompt, setSystemPrompt] = useState(member.systemPrompt);
  const [model, setModel] = useState(member.model ?? '');
  const [toolProfile, setToolProfile] = useState<Member['toolProfile']>(member.toolProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && role.trim().length > 0 && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateMember(member.id, {
        name: name.trim(),
        // 空 handle 不发：它是 @mention 的锚点，不能清空
        ...(handle.trim() ? { handle: handle.trim() } : {}),
        role: role.trim(),
        description: description.trim(),
        style: style.trim(),
        systemPrompt,
        // 空 = 显式回落默认模型（后端按 !== undefined 判断，不会被 ?? 吃掉）
        model: model.trim() || null,
        toolProfile,
      });
      onSaved(result.member);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 归档 = 「不再接活」。
   *
   * 不是删除：这个 Member 仍然是房间里发生过的事实的引用方（历史消息、
   * execution、delegation 都指向它），只是不再作为新的执行目标。
   *
   * 归档前必须把它手上的活收干净。这条规则由服务端强制（未完的 execution /
   * 排队的唤醒都会返回 409），这里只把它的原话显示出来 —— 前端猜不出一条
   * 「还有活」的确切原因，也不该猜。
   */
  async function archive() {
    if (busy) return;
    if (!window.confirm(`归档 ${member.name}？它不会再接受新的任务，历史记录保留。`)) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api.updateMember(member.id, { status: 'archived' });
      onSaved(result.member);
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="member-editor">
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <span>Handle（@mention 用）</span>
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="alice" />
      </label>

      <label className="field">
        <span>Role</span>
        <input value={role} onChange={(e) => setRole(e.target.value)} />
      </label>

      <label className="field">
        <span>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="负责投资研究和事实核查"
        />
      </label>

      <label className="field">
        <span>Personality / Style</span>
        <textarea
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="严谨、怀疑、证据优先、少说废话"
        />
      </label>

      <label className="field">
        <span>System Prompt</span>
        <textarea
          className="tall"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="优先区分事实、推论和不确定性……"
        />
      </label>

      <label className="field">
        <span>Model（留空 = 使用服务端默认模型）</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-5"
        />
      </label>

      <div className="field">
        <span>Tool Profile</span>
        <div className="radio-row">
          <label className="radio">
            <input
              type="radio"
              name="toolProfile"
              checked={toolProfile === 'safe'}
              onChange={() => setToolProfile('safe')}
            />
            Safe
          </label>
          <label className="radio">
            <input
              type="radio"
              name="toolProfile"
              checked={toolProfile === 'coding'}
              onChange={() => setToolProfile('coding')}
            />
            Coding
          </label>
        </div>
        <p className="sidebar-hint">
          Coding 会开放 bash / edit / grep / web_fetch —— 没有 sandbox 时能触达宿主机边界。
        </p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="panel-actions">
        <button type="button" onClick={() => void save()} disabled={!canSave}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {member.status === 'active' && (
          <button
            type="button"
            className="danger"
            onClick={() => void archive()}
            disabled={busy}
            title="归档后不再接受新任务，历史记录保留"
          >
            Archive
          </button>
        )}
        {member.status !== 'active' && <span className="tag">已归档</span>}
      </div>
    </div>
  );
}
