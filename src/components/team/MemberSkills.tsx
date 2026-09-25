import { useEffect, useRef, useState } from 'react';
import { api, type Member, type MemberSkill } from '../../lib/api';

interface MemberSkillsProps {
  member: Member;
}

/**
 * Member 的 skill。
 *
 * skill 是**目录**（`<member home>/skills/<name>/SKILL.md`），通过 Copilot SDK
 * 的 `skillDirectories` 挂进该 Member 的每一个 session —— 所以它是「这个成员
 * 会做什么」，不是附件。磁盘是 source of truth，没有数据库表。
 *
 * 上传走 zip：一个 skill 通常带 references/ 和 scripts/，逐个文件传没有意义。
 */
export function MemberSkills({ member }: MemberSkillsProps) {
  const [skills, setSkills] = useState<MemberSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void api
      .listMemberSkills(member.id)
      .then((result) => {
        if (!cancelled) setSkills(result.skills);
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

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadMemberSkill(member.id, file);
      setSkills((current) => [
        ...current.filter((skill) => skill.name !== result.skill.name),
        result.skill,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      // 同一个文件连选两次也要能触发 onChange
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(name: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteMemberSkill(member.id, name);
      setSkills(result.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="member-skills">
      <p className="sidebar-hint">
        这些 skill 会挂进 {member.name} 的每一个 Copilot session。zip 里需要有
        SKILL.md。
      </p>

      {loading && <p className="sidebar-hint">Loading skills…</p>}

      {!loading && skills.length === 0 && <p className="sidebar-hint">No skills installed.</p>}

      {skills.map((skill) => (
        <div key={skill.name} className="skill-row">
          <div className="skill-ident">
            <strong>{skill.name}</strong>
            <span>{skill.description || '（SKILL.md 里没有描述）'}</span>
            <span className="skill-meta">
              {skill.fileCount} 个文件 · {new Date(skill.updatedAt).toLocaleDateString()}
            </span>
          </div>
          <button
            type="button"
            className="danger"
            onClick={() => void remove(skill.name)}
            disabled={busy}
          >
            Remove
          </button>
        </div>
      ))}

      {error && <div className="error">{error}</div>}

      <div className="panel-actions">
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          disabled={busy}
        />
        {busy && <span className="sidebar-hint">处理中…</span>}
      </div>
    </div>
  );
}
