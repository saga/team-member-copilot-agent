import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Collapse, Modal, Select, Space, Spin, Tabs, Tag } from 'antd';
import {
  GlobalOutlined,
  ReloadOutlined,
  SaveOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api, type CapabilityBinding, type CapabilityProvider, type Member, type MemberCapabilities } from '../../lib/api';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { ScopedSkillLibrary } from './ScopedSkillLibrary';

const EMPTY = (): MemberCapabilities => ({ skills: [], knowledge: [], tools: [] });

type Scope = 'global' | 'team' | 'member';

const KINDS = ['skills', 'knowledge', 'tools'] as const;

/**
 * 类别的显示名。
 *
 * 刻意不写「Skills」而写「Skill sources」：这里配的是**启用了哪些来源**，
 * 不是「装了哪些 skill 文件」。磁盘内容在下面的 Skill Files 里。
 * 两个概念同名的话，界面上会出现「明明装了 skill，这里却是空的」这种
 * 看起来像 bug 的正常状态。
 */
const KIND_LABEL: Record<(typeof KINDS)[number], string> = {
  skills: 'Skill sources',
  knowledge: 'Knowledge sources',
  tools: 'Tools',
};

const SCOPE_LABEL: Record<Scope, string> = {
  global: 'Global',
  team: 'Team',
  member: 'Member',
};

/**
 * 合并优先级：global → team → member，**先出现者胜**。
 *
 * 这个顺序同时也是「谁覆盖谁」的答案，下面的 Effective 面板靠它回答
 * 「这条能力是谁给的」。和 `CapabilityService.getEffective` 里的顺序必须一致。
 */
const LAYER_ORDER: Scope[] = ['global', 'team', 'member'];

const SCOPE_HINT: Record<Scope, ReactNode> = {
  global: '公司级基线，所有 Team 与 Member 默认继承。这里的改动会影响所有人。',
  team: 'Team 级基线，Team 内所有 Agent 继承。它叠在 Global 之上。',
  member: (
    <>
      这里配的是<strong>增量</strong>：这个人比团队多出来的部分。清空 = 退回团队基线，
      不是变成什么都不会的人。
    </>
  ),
};

interface CapabilitySettingsProps {
  onClose: () => void;
}

/** binding 的合并键。与 `CapabilityService` 的去重键一致（selector 缺省 = 空串）。 */
function bindingKey(binding: CapabilityBinding): string {
  return `${binding.providerId}\u0000${binding.selector ?? ''}`;
}

function formatBinding(binding: CapabilityBinding): string {
  return binding.selector ? `${binding.providerId} · ${binding.selector}` : binding.providerId;
}

/**
 * 能力配置窗口：global / team / member 三层，一个窗口三个页签。
 *
 * ── 为什么是「一个窗口」而不是侧栏里的一块 ─────────────────────────────
 *
 * 这三层是**同一件事的三个高度**，而不是三件独立的事。把它们放进同一个窗口的
 * 三个页签，层级关系是看得见的；散在侧栏各处时，「我改的是公司级还是这个人」
 * 只能靠记忆 —— 而这两者的影响面差着一个数量级。
 *
 * ── 编辑的是声明，看到的是结果 ────────────────────────────────────────
 *
 * Member 页签里同时呈现两层信息：上面是**声明**（这个人的增量），下面是
 * **effective**（三层叠加后的真实能力，每条标出是哪一层给的）。只给声明会让人
 * 以为「没配就是没有」—— 而它其实继承了公司级和团队级。
 *
 * ── 未保存的改动不许静默丢 ────────────────────────────────────────────
 *
 * 配置窗口最糟的失败不是「保存失败」，而是编辑被悄悄丢掉：在 Global 页改了
 * 半天，切到 Member 看一眼再关窗 —— 改的东西没了，且没有任何提示。所以关窗
 * 与换人这两处会丢改动的地方都要过一道确认。
 */
export function CapabilitySettings({ onClose }: CapabilitySettingsProps) {
  const [providers, setProviders] = useState<CapabilityProvider[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  const [scope, setScope] = useState<Scope>('global');
  const [memberId, setMemberId] = useState<string | null>(null);

  const [globalCaps, setGlobalCaps] = useState<MemberCapabilities>(EMPTY);
  const [teamCaps, setTeamCaps] = useState<MemberCapabilities>(EMPTY);
  const [memberCaps, setMemberCaps] = useState<MemberCapabilities>(EMPTY);
  const [effective, setEffective] = useState<MemberCapabilities>(EMPTY);

  /** 有未保存改动的层。保存成功、或该层被服务端状态覆盖时移除。 */
  const [dirty, setDirty] = useState<ReadonlySet<Scope>>(new Set());

  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 会丢改动的动作，等用户确认。null = 没有待确认的动作。 */
  const [pendingAction, setPendingAction] = useState<{ message: string; run: () => void } | null>(null);

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

  const reloadMember = useCallback(async () => {
    if (!memberId) return;
    const result = await api.getCapabilityConfig(memberId);
    setMemberCaps(result.config.member);
    setEffective(result.config.effective);
  }, [memberId]);

  // 首次装配：Provider 清单、两层基线、Member 列表。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const [providerResult, globalResult, teamResult, memberResult] = await Promise.all([
          api.listCapabilityProviders(),
          api.getGlobalCapabilities(),
          api.getTeamCapabilities(),
          api.listMembers(),
        ]);
        if (cancelled) return;

        setProviders(providerResult.providers);
        setGlobalCaps(globalResult.capabilities);
        setTeamCaps(teamResult.capabilities);
        setMembers(memberResult.members);
        // 默认落在第一个 Member 上：多数时候进来就是为了看某一个人的能力，
        // 让人先点一次选择器只是多一步。
        setMemberId(memberResult.members[0]?.id ?? null);
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

  // 换人 / 首次拿到 Member：把 member 层草稿换成这个人的服务端状态。
  // 草稿被服务端状态覆盖，所以这一层的「未保存」也随之消失。
  useEffect(() => {
    markClean('member');
    if (!memberId) {
      setMemberCaps(EMPTY());
      setEffective(EMPTY());
      return;
    }
    void reloadMember().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [memberId, reloadMember, markClean]);

  function setCurrentCaps(next: (value: MemberCapabilities) => MemberCapabilities): void {
    if (scope === 'global') setGlobalCaps(next);
    else if (scope === 'team') setTeamCaps(next);
    else setMemberCaps(next);
    markDirty(scope);
  }

  /**
   * 保存**所有**有改动的层，而不是只保存当前页签。
   *
   * 只存当前页签会造出一个安静的陷阱：在 Global 改完、切到 Team 再点保存，
   * Global 的改动留在草稿里，而用户已经看到「保存成功」。按钮上标出层数，
   * 点了就是把待保存的都落地。
   */
  async function saveAll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (dirty.has('global')) {
        setGlobalCaps((await api.updateGlobalCapabilities(globalCaps)).capabilities);
        markClean('global');
      }
      if (dirty.has('team')) {
        setTeamCaps((await api.updateTeamCapabilities(teamCaps)).capabilities);
        markClean('team');
      }
      if (dirty.has('member') && memberId) {
        setMemberCaps((await api.updateMemberCapabilities(memberId, memberCaps)).capabilities);
        markClean('member');
      }
      // 改任何一层都会改变 effective —— 保存后立刻重算，别让界面显示旧结果。
      await reloadMember();
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
      const [providerResult, globalResult, teamResult] = await Promise.all([
        api.listCapabilityProviders(),
        api.getGlobalCapabilities(),
        api.getTeamCapabilities(),
      ]);
      setProviders(providerResult.providers);
      setGlobalCaps(globalResult.capabilities);
      setTeamCaps(teamResult.capabilities);
      setDirty(new Set());
      await reloadMember();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 会丢改动的动作先问一句；没有改动就直接执行。 */
  function guardDirty(scopes: Scope[], message: string, run: () => void): void {
    if (!scopes.some((item) => dirty.has(item))) {
      run();
      return;
    }
    setPendingAction({ message, run });
  }

  const layers = useMemo(
    () => ({ global: globalCaps, team: teamCaps, member: memberCaps }),
    [globalCaps, teamCaps, memberCaps],
  );

  function renderBindings(target: Scope) {
    const caps = target === 'global' ? globalCaps : target === 'team' ? teamCaps : memberCaps;
    return (
      <Collapse
        defaultActiveKey={[...KINDS]}
        items={KINDS.map((kind) => ({
          key: kind,
          label: (
            <Space size={6}>
              <span>{KIND_LABEL[kind]}</span>
              <Tag style={{ marginInlineEnd: 0 }}>{caps[kind].length}</Tag>
            </Space>
          ),
          children: (
            <CapabilityBindingEditor
              kind={kind}
              value={caps[kind]}
              providers={providers}
              onChange={(bindings) => setCurrentCaps((value) => ({ ...value, [kind]: bindings }))}
            />
          ),
        }))}
      />
    );
  }

  /**
   * 三层叠加的结果，每条标出**是哪一层给的**。
   *
   * 这比只列一个合并后的清单多回答一个问题：「我在这里加的东西生效了吗」。
   * 一条在 Member 层也声明了、但 effective 显示来自 Global 的能力，说明这次
   * 声明是多余的 —— 不说出来，用户会以为自己的改动没保存。
   */
  function renderEffective() {
    return (
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        {KINDS.map((kind) => (
          <div key={kind}>
            <strong>{KIND_LABEL[kind]}</strong>
            {effective[kind].length === 0 ? (
              <div style={{ color: '#999', fontSize: 12 }}>（空）</div>
            ) : (
              <div>
                {effective[kind].map((binding) => {
                  const key = bindingKey(binding);
                  const origin = LAYER_ORDER.find((layer) =>
                    layers[layer][kind].some((item) => bindingKey(item) === key),
                  );
                  const shadowed = LAYER_ORDER.filter(
                    (layer) =>
                      layer !== origin &&
                      layers[layer][kind].some((item) => bindingKey(item) === key),
                  );
                  return (
                    <div key={key} style={{ marginBottom: 2 }}>
                      <Tag color={origin === 'member' ? 'green' : origin === 'team' ? 'blue' : 'purple'}>
                        {origin ? SCOPE_LABEL[origin] : '?'}
                      </Tag>
                      <span style={{ fontSize: 12 }}>{formatBinding(binding)}</span>
                      {shadowed.length > 0 ? (
                        <span style={{ color: '#999', fontSize: 12, marginLeft: 6 }}>
                          （{shadowed.map((layer) => SCOPE_LABEL[layer]).join(' / ')} 层也声明了，被上层覆盖）
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        <div style={{ color: '#999', fontSize: 12 }}>
          同一条能力出现在多层时，以 Global → Team → Member 中<strong>最先声明</strong>
          的那一层为准。
        </div>
      </Space>
    );
  }

  function renderScopeBody(target: Scope) {
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

        {renderBindings(target)}

        {target === 'member' && memberId ? (
          <Collapse
            defaultActiveKey={['effective']}
            items={[
              {
                key: 'effective',
                label: 'Effective Capabilities（三层叠加）',
                children: renderEffective(),
              },
            ]}
          />
        ) : null}

        {/*
          Skill 文件（内容投放）和上面的「启用了哪些来源」是两件事，
          但作用域完全一样 —— 所以放在同一个页签里，用标题分开。
        */}
        {target === 'member' && !memberId ? null : (
          <ScopedSkillLibrary
            scope={target}
            memberId={target === 'member' ? (memberId ?? undefined) : undefined}
            title={`${SCOPE_LABEL[target]} Skill Files（装到磁盘上的 skill）`}
          />
        )}
      </Space>
    );
  }

  return (
    <>
      <Modal
        open
        onCancel={() =>
          guardDirty(
            [...LAYER_ORDER],
            '关闭后未保存的改动会丢失。',
            onClose,
          )
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
        /*
         * 滚动放在**页签内容**里，不放在 modal body 上。
         *
         * 放在 body 上时页签栏会跟着内容一起滚走 —— 翻到下面看 Effective 时
         * 就看不见自己在哪一层了，而「我在改哪一层」正是这个窗口最不该让人猜的
         * 信息。所以 body 不滚，每个页签自己滚（见 `.capability-pane`）。
         */
        styles={{ body: { paddingTop: 8 } }}
        title={
          <Space>
            <span>Capabilities</span>
            <span style={{ color: '#999', fontWeight: 400, fontSize: 12 }}>
              effective = global + team + member
            </span>
          </Space>
        }
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
                      Global
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
                      Team
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
                      Member
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

      {/*
        丢改动的确认。刻意用受控 Modal 而不是 `Modal.confirm` 静态方法：
        静态方法渲染在 React 树之外，拿不到 ConfigProvider 的主题，
        也会在 React 19 的并发渲染下出现「同一个确认框弹两次」。
      */}
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
