import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Collapse, Select, Space, Spin, Tabs } from 'antd';
import type { CapabilityProvider, Member, MemberCapabilities } from '../../lib/api';
import { api } from '../../lib/api';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { ScopedSkillLibrary } from './ScopedSkillLibrary';

const EMPTY = (): MemberCapabilities => ({ skills: [], knowledge: [], tools: [] });

type Scope = 'global' | 'team' | 'member';

const KINDS = ['skills', 'knowledge', 'tools'] as const;

interface Props {
  members: Member[];
}

/**
 * 能力的三层管理界面：global / team / member。
 *
 * ── 为什么是「三层」而不是「一个人的能力」 ────────────────────────────────
 *
 * `effective = global + team + member`。只给 Member 层的编辑器会让人以为
 * 「没配就是没有」—— 而它其实继承了公司级和团队级。所以这里同时呈现三层，
 * 并在 Member 页签里额外显示合并结果：改的是**增量**，看到的是**结果**。
 *
 * global / team 两层的改动会影响**所有人**，所以它们和 Member 层在同一个
 * 界面里但分在不同的页签 —— 层级关系必须是看得见的，不能靠记忆。
 */
export function CapabilityManager({ members }: Props) {
  const [providers, setProviders] = useState<CapabilityProvider[]>([]);
  const [selectedScope, setSelectedScope] = useState<Scope>('global');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(members[0]?.id ?? null);

  const [globalCaps, setGlobalCaps] = useState<MemberCapabilities>(EMPTY);
  const [teamCaps, setTeamCaps] = useState<MemberCapabilities>(EMPTY);
  const [memberCaps, setMemberCaps] = useState<MemberCapabilities>(EMPTY);
  const [effectiveCaps, setEffectiveCaps] = useState<MemberCapabilities>(EMPTY);

  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 被选中的 Member 被删掉之后，选择必须跟着落回一个还存在的人，
  // 否则后面每一次请求都会 404。
  useEffect(() => {
    if (selectedMemberId && !members.some((member) => member.id === selectedMemberId)) {
      setSelectedMemberId(members[0]?.id ?? null);
    }
  }, [members, selectedMemberId]);

  const reloadMember = useCallback(async () => {
    if (!selectedMemberId) return;
    const result = await api.getCapabilityConfig(selectedMemberId);
    setMemberCaps(result.config.member);
    setEffectiveCaps(result.config.effective);
  }, [selectedMemberId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const [providerResult, globalResult, teamResult] = await Promise.all([
          api.listCapabilityProviders(),
          api.getGlobalCapabilities(),
          api.getTeamCapabilities(),
        ]);
        if (cancelled) return;

        setProviders(providerResult.providers);
        setGlobalCaps(globalResult.capabilities);
        setTeamCaps(teamResult.capabilities);

        if (selectedMemberId) {
          const result = await api.getCapabilityConfig(selectedMemberId);
          if (cancelled) return;
          setMemberCaps(result.config.member);
          setEffectiveCaps(result.config.effective);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedMemberId]);

  async function save(scope: Scope) {
    setBusy(true);
    setError(null);
    try {
      if (scope === 'global') {
        setGlobalCaps((await api.updateGlobalCapabilities(globalCaps)).capabilities);
      } else if (scope === 'team') {
        setTeamCaps((await api.updateTeamCapabilities(teamCaps)).capabilities);
      } else if (selectedMemberId) {
        setMemberCaps((await api.updateMemberCapabilities(selectedMemberId, memberCaps)).capabilities);
      }
      // 改任何一层都会改变 effective —— 保存后立刻重算，别让界面显示旧结果。
      await reloadMember();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const currentCaps =
    selectedScope === 'global' ? globalCaps : selectedScope === 'team' ? teamCaps : memberCaps;

  function setCurrentCaps(next: (value: MemberCapabilities) => MemberCapabilities) {
    if (selectedScope === 'global') setGlobalCaps(next);
    else if (selectedScope === 'team') setTeamCaps(next);
    else setMemberCaps(next);
  }

  if (loading) {
    return <Spin size="small" tip="Loading capabilities…" />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Tabs
        activeKey={selectedScope}
        onChange={(key) => setSelectedScope(key as Scope)}
        items={[
          { key: 'global', label: 'Global' },
          { key: 'team', label: 'Team' },
          { key: 'member', label: 'Member' },
        ]}
      />

      {selectedScope === 'global' ? (
        <span style={{ color: '#999', fontSize: 12 }}>
          Global 是公司级基线，所有 Agent 默认继承。改动会影响**所有** Team 与 Member。
        </span>
      ) : null}

      {selectedScope === 'team' ? (
        <span style={{ color: '#999', fontSize: 12 }}>
          Team 级基线，Team 内所有 Agent 继承。它叠在 Global 之上。
        </span>
      ) : null}

      {selectedScope === 'member' ? (
        <Select
          style={{ width: '100%' }}
          value={selectedMemberId ?? undefined}
          placeholder="Select Member"
          options={members.map((member) => ({
            value: member.id,
            label: `${member.name} (@${member.handle})`,
          }))}
          onChange={(id) => setSelectedMemberId(id)}
        />
      ) : null}

      {selectedScope === 'member' && selectedMemberId ? (
        <span style={{ color: '#999', fontSize: 12 }}>
          这里配的是**增量**：下面三层叠加后的结果就是这个人实际能用的能力。
        </span>
      ) : null}

      <Collapse
        defaultActiveKey={[...KINDS]}
        items={KINDS.map((kind) => ({
          key: kind,
          label: kind,
          children: (
            <CapabilityBindingEditor
              kind={kind}
              value={currentCaps[kind]}
              providers={providers}
              onChange={(bindings) => setCurrentCaps((value) => ({ ...value, [kind]: bindings }))}
            />
          ),
        }))}
      />

      <Button
        type="primary"
        loading={busy}
        onClick={() => void save(selectedScope)}
        disabled={selectedScope === 'member' && !selectedMemberId}
      >
        Save
      </Button>

      {selectedScope === 'member' && selectedMemberId ? (
        <>
          <Collapse
            items={[
              {
                key: 'effective',
                label: 'Effective Capabilities',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {KINDS.map((kind) => (
                      <div key={kind}>
                        <strong>{kind}</strong>
                        <div>
                          {effectiveCaps[kind].map((binding) => (
                            <span
                              key={`${binding.providerId}#${binding.selector ?? ''}`}
                              style={{ marginRight: 6 }}
                            >
                              {binding.providerId}
                              {binding.selector ? ` · ${binding.selector}` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </Space>
                ),
              },
            ]}
          />

          <ScopedSkillLibrary scope="member" memberId={selectedMemberId} title="Member Skill Files" />
        </>
      ) : (
        <ScopedSkillLibrary
          scope={selectedScope}
          title={selectedScope === 'global' ? 'Global Skill Files' : 'Team Skill Files'}
        />
      )}
    </Space>
  );
}
