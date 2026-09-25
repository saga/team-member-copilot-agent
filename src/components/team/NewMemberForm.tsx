import { useState } from 'react';

interface NewMemberFormProps {
  onCreate: (input: { name: string; role: string }) => Promise<void>;
  onCancel: () => void;
}

/**
 * 快速新建 Member：只收 name + role。
 *
 * 剩下的 description / style / systemPrompt / model 由 MemberProfile 补 ——
 * 那是一个需要人认真填的表单，不该塞进侧栏。
 */
export function NewMemberForm({ onCreate, onCancel }: NewMemberFormProps) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);

  const canCreate = name.trim().length > 0 && role.trim().length > 0 && !busy;

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), role: role.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="new-member">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Member name"
        autoFocus
      />
      <input
        value={role}
        onChange={(e) => setRole(e.target.value)}
        placeholder="Role"
      />
      <div className="panel-actions">
        <button type="button" onClick={() => void submit()} disabled={!canCreate}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
