import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Modal,
  Popover,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Upload,
} from 'antd';
import {
  DeleteOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  api,
  type CatalogScope,
  type CatalogTool,
  type Member,
  type ScopeCatalog,
} from '../../lib/api';

type Scope = CatalogScope;

interface Draft {
  skills: string[];
  knowledge: string[];
  tools: string[];
}

const SCOPE_HINT: Record<Scope, ReactNode> = {
  global: '这些能力会自动提供给所有 Team 和 Member。这里的改动会影响所有人。',
  team: '这个 Team 中的所有 Member 自动获得。它叠在公司默认之上。',
  member: (
    <>
      这个 Member <strong>额外拥有</strong>的能力。清空 = 退回团队基线，
      不是变成什么都不会的人。
    </>
  ),
};

const LAYER_ORDER: Scope[] = ['global', 'team', 'member'];

interface CapabilitySettingsProps {
  onClose: () => void;
}

/** 服务端目录 → 本地草稿：勾选态即 enabled。 */
function draftFromCatalog(catalog: ScopeCatalog): Draft {
  return {
    skills: catalog.skills.filter((item) => item.enabled).map((item) => item.id),
    knowledge: catalog.knowledge.filter((item) => item.enabled).map((item) => item.id),
    tools: catalog.tools.filter((item) => item.enabled).map((item) => item.id),
  };
}

/**
 * 能力配置窗口：公司默认 / 团队默认 / 这个人，一个窗口三个页签。
 *
 * 三层是同一件事的三个高度 —— 放在一个窗口里，「我改的是公司级还是这个人」
 * 才看得见。页签里只出现 Skill / Knowledge / Action 的名字与开关，
 * providerId / selector 只存在后端。
 */
export function CapabilitySettings({ onClose }: CapabilitySettingsProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [scope, setScope] = useState<Scope>('global');
  const [memberId, setMemberId] = useState<string | null>(null);

  const [catalogs, setCatalogs] = useState<Record<Scope, ScopeCatalog | null>>({
    global: null,
    team: null,
    member: null,
  });
  const [drafts, setDrafts] = useState<Record<Scope, Draft | null>>({
    global: null,
    team: null,
    member: null,
  });
  const [dirty, setDirty] = useState<ReadonlySet<Scope>>(new Set());

  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ message: string; run: () => void } | null>(
    null,
  );

  const markClean = useCallback((target: Scope) => {
    setDirty((current) => {
      if (!current.has(target)) return current;
      const next = new Set(current);
      next.delete(target);
      return next;
    });
  }, []);

  const markDirty = useCallback((target: Scope) => {
    setDirty((current) => (current.has(target) ? current : new Set(current).add(target)));
  }, []);

  const loadScope = useCallback(
    async (target: Scope, forMemberId: string | null): Promise<void> => {
      const result = await api.getCapabilityCatalog(
        target,
        target === 'member' ? (forMemberId ?? undefined) : undefined,
      );
      setCatalogs((current) => ({ ...current, [target]: result.catalog }));
      setDrafts((current) => ({ ...current, [target]: draftFromCatalog(result.catalog) }));
      markClean(target);
    },
    [markClean],
  );

  // 首次装配：两层基线 + Member 列表。默认落在第一个 Member 上。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const memberResult = await api.listMembers();
        if (cancelled) return;
        setMembers(memberResult.members);
        const first = memberResult.members[0]?.id ?? null;
        setMemberId(first);
        await Promise.all([
          (async () => {
            const result = await api.getCapabilityCatalog('global');
            if (cancelled) return;
            setCatalogs((current) => ({ ...current, global: result.catalog }));
            setDrafts((current) => ({ ...current, global: draftFromCatalog(result.catalog) }));
          })(),
          (async () => {
            const result = await api.getCapabilityCatalog('team');
            if (cancelled) return;
            setCatalogs((current) => ({ ...current, team: result.catalog }));
            setDrafts((current) => ({ ...current, team: draftFromCatalog(result.catalog) }));
          })(),
        ]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 换人 / 首次拿到 Member：member 层草稿换成这个人的服务端状态。
  useEffect(() => {
    markClean('member');
    if (!memberId) {
      setCatalogs((current) => ({ ...current, member: null }));
      setDrafts((current) => ({ ...current, member: null }));
      return;
    }
    void loadScope('member', memberId).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [memberId, loadScope, markClean]);

  function toggle(target: Scope, kind: keyof Draft, id: string): void {
    setDrafts((current) => {
      const draft = current[target];
      if (!draft) return current;
      const selected = draft[kind].includes(id)
        ? draft[kind].filter((item) => item !== id)
        : [...draft[kind], id];
      return { ...current, [target]: { ...draft, [kind]: selected } };
    });
    markDirty(target);
  }

  async function saveScope(target: Scope, draft: Draft): Promise<void> {
    const result = await api.updateCapabilityCatalog({
      scope: target,
      memberId: target === 'member' ? (memberId ?? undefined) : undefined,
      ...draft,
    });
    setCatalogs((current) => ({ ...current, [target]: result.catalog }));
    setDrafts((current) => ({ ...current, [target]: draftFromCatalog(result.catalog) }));
    markClean(target);
  }

  /** 保存所有有改动的层。只存当前页签会让人以为 Global 的改动丢了。 */
  async function saveAll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      for (const target of LAYER_ORDER) {
        const draft = drafts[target];
        if (!dirty.has(target) || !draft) continue;
        if (target === 'member' && !memberId) continue;
        await saveScope(target, draft);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reload(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await Promise.all([
        loadScope('global', null),
        loadScope('team', null),
        ...(memberId ? [loadScope('member', memberId)] : []),
      ]);
      setDirty(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function guardDirty(scopes: Scope[], message: string, run: () => void): void {
    if (!scopes.some((item) => dirty.has(item))) {
      run();
      return;
    }
    setPendingAction({ message, run });
  }

  /**
   * 上传即启用：装完立刻把新 skill 勾上并保存。
   *
   * 已经全选（后端 selector 缺省 = 全部）时新 skill 本来就在范围内，
   * 重载目录即可；否则显式保存一次，避免「装了却没开」的中间态。
   */
  async function uploadSkill(target: Scope, file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const uploaded = await api.uploadScopedSkill(
        target,
        file,
        target === 'member' ? (memberId ?? undefined) : undefined,
      );
      const fresh = await api.getCapabilityCatalog(
        target,
        target === 'member' ? (memberId ?? undefined) : undefined,
      );
      const draft = draftFromCatalog(fresh.catalog);
      const newId = `skill.${uploaded.skill.name}`;
      const next: Draft = draft.skills.includes(newId)
        ? draft
        : { ...draft, skills: [...draft.skills, newId] };
      const saved = await api.updateCapabilityCatalog({
        scope: target,
        memberId: target === 'member' ? (memberId ?? undefined) : undefined,
        ...next,
      });
      setCatalogs((current) => ({ ...current, [target]: saved.catalog }));
      setDrafts((current) => ({ ...current, [target]: draftFromCatalog(saved.catalog) }));
      markClean(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeSkill(target: Scope, name: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.deleteScopedSkill(
        target,
        name,
        target === 'member' ? (memberId ?? undefined) : undefined,
      );
      const fresh = await api.getCapabilityCatalog(
        target,
        target === 'member' ? (memberId ?? undefined) : undefined,
      );
      setCatalogs((current) => ({ ...current, [target]: fresh.catalog }));
      // 删掉的 id 从草稿里拿掉，其余未保存的改动保留。
      setDrafts((current) => {
        const draft = current[target];
        if (!draft) return current;
        const removed = `skill.${name}`;
        return {
          ...current,
          [target]: {
            ...draft,
            skills: draft.skills.filter((id) => id !== removed),
          },
        };
      });
      markDirty(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderSkills(target: Scope) {
    const catalog = catalogs[target];
    const draft = drafts[target];
    if (!catalog || !draft) return <Spin size="small" tip="Loading…" />;

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        {catalog.skills.length === 0 ? (
          <div style={{ color: '#999', fontSize: 12 }}>还没有安装任何 Skill。</div>
        ) : (
          catalog.skills.map((skill) => (
            <div key={skill.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Checkbox
                checked={draft.skills.includes(skill.id)}
                onChange={() => toggle(target, 'skills', skill.id)}
              >
                <strong>{skill.name}</strong>
                <div style={{ color: '#666', fontSize: 12 }}>
                  {skill.description || '(no description)'}
                </div>
              </Checkbox>
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                disabled={busy}
                onClick={() => void removeSkill(target, skill.name)}
                style={{ marginLeft: 'auto' }}
              >
                Remove
              </Button>
            </div>
          ))
        )}
        <Upload
          accept=".zip,application/zip"
          showUploadList={false}
          disabled={busy}
          beforeUpload={(file) => {
            void uploadSkill(target, file);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />} loading={busy}>
            Add skill
          </Button>
        </Upload>
      </Space>
    );
  }

  function renderKnowledge(target: Scope) {
    const catalog = catalogs[target];
    const draft = drafts[target];
    if (!catalog || !draft) return <Spin size="small" tip="Loading…" />;

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        {catalog.knowledge.length === 0 ? (
          <div style={{ color: '#999', fontSize: 12 }}>还没有可用的知识库。</div>
        ) : (
          catalog.knowledge.map((kb) => (
            <Checkbox
              key={kb.id}
              checked={draft.knowledge.includes(kb.id)}
              onChange={() => toggle(target, 'knowledge', kb.id)}
            >
              <strong>{kb.name}</strong>{' '}
              <Tag style={{ marginInlineEnd: 0 }}>{kb.documentCount} documents</Tag>{' '}
              <Tag style={{ marginInlineEnd: 0 }}>{kb.scope === 'personal' ? 'Personal' : 'Team'}</Tag>
              <div style={{ color: '#666', fontSize: 12 }}>{kb.description}</div>
            </Checkbox>
          ))
        )}
        <div style={{ color: '#999', fontSize: 12 }}>
          选中资料库后，Agent 自动获得检索与原文查看能力，无需单独配置。
        </div>
      </Space>
    );
  }

  function toolDetails(tool: CatalogTool) {
    return (
      <Space direction="vertical" size="small" style={{ maxWidth: 320 }}>
        <div>
          <strong>What it does</strong>
          <div>{tool.description}</div>
        </div>
        <div>
          <strong>Risk</strong>
          <div>{tool.risk}</div>
        </div>
        <div>
          <strong>Requires approval</strong>
          <div>{tool.needsApproval ? 'Yes — 每次调用要过 Policy 审批' : 'No'}</div>
        </div>
        {!tool.available ? (
          <div>
            <strong>Why unavailable</strong>
            <div>{tool.unavailableReason}</div>
          </div>
        ) : null}
      </Space>
    );
  }

  function renderActions(target: Scope) {
    const catalog = catalogs[target];
    const draft = drafts[target];
    if (!catalog || !draft) return <Spin size="small" tip="Loading…" />;

    const groups = new Map<string, CatalogTool[]>();
    for (const tool of catalog.tools) {
      const list = groups.get(tool.group) ?? [];
      list.push(tool);
      groups.set(tool.group, list);
    }

    if (groups.size === 0) {
      return <div style={{ color: '#999', fontSize: 12 }}>当前部署没有可用的 Action。</div>;
    }

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {[...groups].map(([group, tools]) => (
          <div key={group}>
            <strong>{group}</strong>
            <div style={{ marginTop: 4 }}>
              {tools.map((tool) => (
                <div key={tool.id} style={{ marginBottom: 6 }}>
                  <Checkbox
                    checked={draft.tools.includes(tool.id)}
                    disabled={!tool.available}
                    onChange={() => toggle(target, 'tools', tool.id)}
                  >
                    <strong>{tool.displayName}</strong>{' '}
                    <Popover content={toolDetails(tool)} title={tool.displayName} trigger="click">
                      <Button
                        type="link"
                        size="small"
                        icon={<InfoCircleOutlined />}
                        style={{ padding: 0, height: 'auto' }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popover>{' '}
                    {tool.needsApproval ? <Tag color="orange">Needs approval</Tag> : null}
                    {!tool.available ? <Tag color="red">Unavailable</Tag> : null}
                    <div style={{ color: '#666', fontSize: 12 }}>{tool.description}</div>
                    {!tool.available && tool.unavailableReason ? (
                      <div style={{ color: '#a00', fontSize: 12 }}>{tool.unavailableReason}</div>
                    ) : null}
                  </Checkbox>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Space>
    );
  }

  function renderInherited(target: Scope) {
    if (target !== 'member') return null;
    const catalog = catalogs.member;
    if (!catalog?.inherited) return null;
    const { inherited } = catalog;

    const renderRefs = (refs: Array<{ id: string; name: string; from: 'company' | 'team' }>) =>
      refs.length === 0 ? (
        <span style={{ color: '#999', fontSize: 12 }}>（无）</span>
      ) : (
        refs.map((ref) => (
          <Tag key={`${ref.from}-${ref.id}`} style={{ marginBottom: 4 }}>
            {ref.name} · {ref.from === 'company' ? 'Company' : 'Team'}
          </Tag>
        ))
      );

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <div>
          <strong>Inherited from company & team</strong>
          <div style={{ color: '#999', fontSize: 12 }}>
            这些能力自动拥有，在上面两层里改，不在这里改。
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#666' }}>Skills</div>
          <div>{renderRefs(inherited.skills)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#666' }}>Knowledge</div>
          <div>{renderRefs(inherited.knowledge)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#666' }}>Actions</div>
          <div>{renderRefs(inherited.tools)}</div>
        </div>
      </Space>
    );
  }

  function renderScopeBody(target: Scope) {
    const catalog = catalogs[target];
    const draft = drafts[target];

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert type="info" showIcon message={SCOPE_HINT[target]} />

        {target === 'member' ? (
          members.length === 0 ? (
            <Alert type="warning" showIcon message="还没有任何 Member，先建一个人再来配它的增量能力。" />
          ) : (
            <Select
              style={{ width: '100%' }}
              value={memberId ?? undefined}
              placeholder="选择 Member"
              showSearch
              optionFilterProp="label"
              options={members.map((member) => ({
                value: member.id,
                label: `${member.name} · @${member.handle} · ${member.role}`,
              }))}
              onChange={(next) =>
                guardDirty(['member'], '切换 Member 后，这个 Member 上未保存的改动会丢失。', () =>
                  setMemberId(next),
                )
              }
            />
          )
        ) : null}

        {target === 'member' && !memberId ? null : (
          <>
            {renderInherited(target)}
            <Collapse
              defaultActiveKey={['skills', 'knowledge', 'actions']}
              items={[
                {
                  key: 'skills',
                  label: (
                    <Space size={6}>
                      <span>Skills</span>
                      <Tag style={{ marginInlineEnd: 0 }}>{draft?.skills.length ?? 0} enabled</Tag>
                    </Space>
                  ),
                  children: renderSkills(target),
                },
                {
                  key: 'knowledge',
                  label: (
                    <Space size={6}>
                      <span>Knowledge</span>
                      <Tag style={{ marginInlineEnd: 0 }}>{draft?.knowledge.length ?? 0} enabled</Tag>
                    </Space>
                  ),
                  children: renderKnowledge(target),
                },
                {
                  key: 'actions',
                  label: (
                    <Space size={6}>
                      <span>Actions</span>
                      <Tag style={{ marginInlineEnd: 0 }}>{draft?.tools.length ?? 0} enabled</Tag>
                    </Space>
                  ),
                  children: renderActions(target),
                },
              ]}
            />
            {catalog ? null : <Spin size="small" tip="Loading…" />}
          </>
        )}
      </Space>
    );
  }

  return (
    <>
      <Modal
        open
        onCancel={() =>
          guardDirty([...LAYER_ORDER], '关闭后未保存的改动会丢失。', onClose)
        }
        footer={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              disabled={busy}
              onClick={() => guardDirty([...LAYER_ORDER], '重新加载后未保存的改动会丢失。', () => void reload())}
            >
              Reload
            </Button>
            <Button onClick={() => guardDirty([...LAYER_ORDER], '关闭后未保存的改动会丢失。', onClose)}>
              Cancel
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={busy}
              disabled={dirty.size === 0}
              onClick={() => void saveAll()}
            >
              {dirty.size > 1 ? `Save ${dirty.size} layers` : 'Save'}
            </Button>
          </Space>
        }
        width={880}
        styles={{ body: { paddingTop: 8 } }}
        title={<Space><span>Capabilities</span></Space>}
      >
        {loading ? (
          <Spin tip="Loading capabilities…" />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {error ? <Alert type="error" showIcon closable message={error} onClose={() => setError(null)} /> : null}

            <Tabs
              activeKey={scope}
              onChange={(key) => setScope(key as Scope)}
              items={[
                {
                  key: 'global',
                  label: (
                    <Space size={6}>
                      <GlobalOutlined />
                      Company defaults
                      {dirty.has('global') ? <Badge status="warning" /> : null}
                    </Space>
                  ),
                  children: <div className="capability-pane">{renderScopeBody('global')}</div>,
                },
                {
                  key: 'team',
                  label: (
                    <Space size={6}>
                      <TeamOutlined />
                      Team defaults
                      {dirty.has('team') ? <Badge status="warning" /> : null}
                    </Space>
                  ),
                  children: <div className="capability-pane">{renderScopeBody('team')}</div>,
                },
                {
                  key: 'member',
                  label: (
                    <Space size={6}>
                      <UserOutlined />
                      This member
                      {dirty.has('member') ? <Badge status="warning" /> : null}
                    </Space>
                  ),
                  children: <div className="capability-pane">{renderScopeBody('member')}</div>,
                },
              ]}
            />
          </Space>
        )}
      </Modal>

      <Modal
        open={pendingAction !== null}
        title="有未保存的改动"
        okText="放弃改动"
        okButtonProps={{ danger: true }}
        cancelText="继续编辑"
        onOk={() => {
          const action = pendingAction;
          setPendingAction(null);
          action?.run();
        }}
        onCancel={() => setPendingAction(null)}
      >
        {pendingAction?.message}
      </Modal>
    </>
  );
}
