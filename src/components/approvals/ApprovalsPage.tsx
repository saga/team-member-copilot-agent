import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../lib/api';
import type {
  CommandAttemptStatus,
  CommandAuditEvent,
  CommandDetail,
  CommandRecord,
  CommandStatus,
} from '../../lib/api';

/**
 * 审批收件箱 —— 外部写入的放行出口。
 *
 * ── 它为什么必须存在 ─────────────────────────────────────────────────
 *
 * 默认 Policy 对一切 external-write 返回 `approvalRequired`，于是 Command 停在
 * `policy_pending` 不动。这是**刻意**的（「能列出工具」和「能执行动作」是两件事），
 * 但它意味着没有审批出口时，所有 Jira 评论与流转都永久停在待审批 —— Agent 会
 * 一直告诉用户「请让有权限的人审批后再试」，而那个「有权限的人」没有地方可去。
 *
 * ── 界面上的两个要点 ─────────────────────────────────────────────────
 *
 * 1. **参数必须显示出来**。人批的是「这条评论写什么、这张单流转到哪」，
 *    而不是「有一条 jira.add_comment」。参数是冻结在 Command 上的那一份
 *    （args_json），执行时用的就是它 —— 所以这里显示的和真正执行的必然一致。
 *
 * 2. **生命周期要能看见**。谁请求的、Policy 判了什么、谁批的、什么时候开始执行、
 *    成没成 —— command 行上只有当前状态，过程在 command_audit 里。
 */

/** 状态 → 展示。红色系留给「出事了」，蓝色系留给「在流程里」。 */
const STATUS_META: Record<CommandStatus, { label: string; color: string }> = {
  requested: { label: '已请求', color: 'default' },
  policy_pending: { label: '待审批', color: 'gold' },
  approved: { label: '已批准', color: 'blue' },
  ready: { label: '待执行', color: 'blue' },
  executing: { label: '执行中', color: 'processing' },
  completed: { label: '已完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
  // 不是 failed：failed 是「确认没发生」，可以重试；unknown 是「可能已经发生」，
  // 重试就是重复副作用。用橙色而不是红色，是因为它需要的是**看一眼**，不是「出事了」。
  unknown: { label: '结果未知', color: 'orange' },
  rejected: { label: '已驳回', color: 'red' },
  cancelled: { label: '已取消', color: 'default' },
  expired: { label: '已过期', color: 'default' },
};

const EVENT_LABEL: Record<CommandAuditEvent, string> = {
  requested: '请求',
  policy_decided: 'Policy 判定',
  approval_requested: '提交审批',
  approved: '批准',
  rejected: '驳回',
  executing: '开始执行',
  completed: '执行完成',
  failed: '执行失败',
  unknown: '结果未知',
};

/** 生命周期里「不是好事」的事件，时间轴上用红点。 */
const BAD_EVENTS = new Set<CommandAuditEvent>(['rejected', 'failed', 'unknown']);

/** 一次尝试的结果 → 展示。 */
const ATTEMPT_META: Record<CommandAttemptStatus, { label: string; color: string }> = {
  running: { label: '执行中', color: 'processing' },
  succeeded: { label: '成功', color: 'green' },
  failed: { label: '失败', color: 'red' },
  // 「未知」不是「失败」：失败能重试，未知不能。
  unknown: { label: '未知', color: 'orange' },
};

/**
 * 收件箱的分页。按状态查，不按 execution 查 —— 见 api.ts 的注释。
 *
 * `unknown` 单独一页是刻意的：它是一条**必须有人看一眼**的状态（有一笔外部写入
 * 我们不知道做没做），而它既不属于「已完成」也不属于「已驳回」。塞进任何一页
 * 都会让人以为事情已经了结。
 */
const INBOX_TABS: Array<{ key: CommandStatus; label: string }> = [
  { key: 'policy_pending', label: '待审批' },
  { key: 'unknown', label: '结果未知' },
  { key: 'completed', label: '已完成' },
  { key: 'rejected', label: '已驳回' },
];

export function ApprovalsPage() {
  const [status, setStatus] = useState<CommandStatus>('policy_pending');
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在查看的那一条（详情抽屉）。null = 关着。 */
  const [detail, setDetail] = useState<CommandDetail | null>(null);
  /** 正在提交的 Command id —— 按钮上转圈，也顺手挡掉重复点击。 */
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (next: CommandStatus) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.listCommandsByStatus(next);
        setCommands(result.commands);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(status);
  }, [load, status]);

  /**
   * 审批动作。
   *
   * 成功后**重新拉列表**而不是就地改状态：审批会推进 Command 的生命周期
   * （approve 默认连执行一起做），本地改一个 status 字段会显示出一个服务端
   * 从没承认过的中间态。抽屉里的详情也一并刷新，因为它的 audit 数组变了。
   */
  async function act(id: string, action: 'approve' | 'reject' | 'execute' | 'reconcile') {
    setBusyId(id);
    try {
      const updated =
        action === 'approve'
          ? await api.approveCommand(id)
          : action === 'reject'
            ? await api.rejectCommand(id)
            : action === 'reconcile'
              ? await api.reconcileCommand(id)
              : await api.executeCommand(id);
      setDetail(updated);
      await load(status);
      // 对账的提示要说结论，不能说「成功」：`unknown` 是**合法**结论（对账自己
      // 也没读到），而把它显示成成功会让人以为事情已经了结。
      if (action === 'reconcile') {
        const outcome = (updated as { outcome?: { status: string; detail?: string | null } })
          .outcome;
        message.info(
          outcome
            ? `对账结论：${outcome.status}${outcome.detail ? ` —— ${outcome.detail}` : ''}`
            : '对账完成',
        );
      } else {
        message.success(
          action === 'approve' ? '已批准' : action === 'reject' ? '已驳回' : '已执行',
        );
      }
    } catch (err) {
      // 冲突（409）在这里是**预期**的：另一个人先批了 / 执行者已经接手。
      // 所以不弹「失败」，而是把服务端的原话显示出来并刷新列表 ——
      // 用户需要看到的是「它现在的状态」，不是「你的操作失败了」。
      message.error(err instanceof Error ? err.message : String(err));
      await load(status);
    } finally {
      setBusyId(null);
    }
  }

  const columns: ColumnsType<CommandRecord> = [
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      render: (action: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{action}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.target}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: CommandStatus) => (
        <Tag color={STATUS_META[value].color}>{STATUS_META[value].label}</Tag>
      ),
    },
    {
      title: '请求者',
      dataIndex: 'actorId',
      key: 'actorId',
      width: 200,
      render: (actorId: string, row) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {row.actorType === 'agent' ? 'Agent ' : 'Human '}
          {actorId}
        </Typography.Text>
      ),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }}>{formatTime(value)}</Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_value, row) => (
        <Space size={4}>
          <Button size="small" onClick={() => void openDetail(row.id)}>
            详情
          </Button>
          {row.status === 'policy_pending' && (
            <>
              <Popconfirm
                title="批准并执行？"
                description="批准后会立刻对 Jira 发起这笔写入。"
                okText="批准"
                cancelText="取消"
                onConfirm={() => void act(row.id, 'approve')}
              >
                <Button size="small" type="primary" loading={busyId === row.id}>
                  批准
                </Button>
              </Popconfirm>
              <Popconfirm
                title="驳回这笔写入？"
                description="驳回后它落到终态，不能再次执行。"
                okText="驳回"
                cancelText="取消"
                onConfirm={() => void act(row.id, 'reject')}
              >
                <Button size="small" danger loading={busyId === row.id}>
                  驳回
                </Button>
              </Popconfirm>
            </>
          )}
          {(row.status === 'approved' || row.status === 'ready') && (
            <Button size="small" loading={busyId === row.id} onClick={() => void act(row.id, 'execute')}>
              执行
            </Button>
          )}
        </Space>
      ),
    },
  ];

  async function openDetail(id: string) {
    try {
      setDetail(await api.getCommand(id));
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ padding: '12px 18px', height: '100%', overflowY: 'auto' }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space>
          <Segmented
            value={status}
            onChange={(value) => setStatus(value as CommandStatus)}
            options={INBOX_TABS.map((tab) => ({ value: tab.key, label: tab.label }))}
          />
          <Button size="small" onClick={() => void load(status)} loading={loading}>
            刷新
          </Button>
        </Space>

        <Alert
          type="info"
          showIcon
          message="外部写入需要人批准"
          description={
            'Agent 想做的评论 / 流转会先落成一条 Command 停在这里，批准后才真正打到外部系统。' +
            '参数在请求时就已冻结，执行时用的就是你在详情里看到的那一份。'
          }
        />

        {error && <Alert type="error" showIcon message={error} />}

        <Spin spinning={loading}>
          <Table<CommandRecord>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={commands}
            pagination={false}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    status === 'policy_pending'
                      ? '没有待审批的外部写入'
                      : status === 'unknown'
                        ? '没有结果未知的外部写入'
                        : '这里还是空的'
                  }
                />
              ),
            }}
          />
        </Spin>
      </Space>

      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={620}
        title="Command 详情"
        destroyOnClose
      >
        {detail && <CommandDetailView detail={detail} busyId={busyId} onAct={act} />}
      </Drawer>
    </div>
  );
}

function CommandDetailView({
  detail,
  busyId,
  onAct,
}: {
  detail: CommandDetail;
  busyId: string | null;
  onAct: (id: string, action: 'approve' | 'reject' | 'execute' | 'reconcile') => Promise<void>;
}) {
  const { command, approval, audit, attempts } = detail;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="动作">{command.action}</Descriptions.Item>
        <Descriptions.Item label="目标">{command.target}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={STATUS_META[command.status].color}>{STATUS_META[command.status].label}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="请求者">
          {command.actorType} / {command.actorId}
        </Descriptions.Item>
        <Descriptions.Item label="幂等键">
          <Typography.Text code style={{ fontSize: 12 }}>
            {command.idempotencyKey}
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="工单版本">
          {command.resourceVersion ?? '（无 —— Provider 不提供版本概念）'}
        </Descriptions.Item>
        <Descriptions.Item label="参数哈希">
          <Typography.Text code style={{ fontSize: 11 }}>
            {command.argsHash}
          </Typography.Text>
        </Descriptions.Item>
      </Descriptions>

      {/*
        `unknown` 不给任何操作按钮 —— 这是刻意的。它不是「失败」，所以没有
        「重试」；它也不是「待审批」，所以没有「批准」。这里唯一正确的下一步是
        对账（确认外部系统到底做没做），而那一步还没有入口。给一个看起来能解决
        问题的按钮，只会让人用它去做那个恰恰会产生重复副作用的动作。
      */}
      {command.status === 'unknown' && (
        <Alert
          type="warning"
          showIcon
          message="这笔外部写入的结果未知"
          description={
            '请求已经发出，但没能确认外部系统是否处理了它（超时 / 连接重置 / 5xx）。' +
            '它和「失败」不是一回事：失败是确认没发生、可以直接重试；这里是**可能已经发生**，' +
            '重试会产生第二次副作用。需要先对账确认它到底做没做。'
          }
        />
      )}

      {/* 参数是审批的核心：人批的就是这一份。 */}
      <div>
        <Typography.Title level={5}>参数（执行时使用的冻结副本）</Typography.Title>
        <pre
          style={{
            background: '#fafafa',
            border: '1px solid #f0f0f0',
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
            overflowX: 'auto',
            margin: 0,
          }}
        >
          {JSON.stringify(command.args, null, 2)}
        </pre>
      </div>

      {approval && (
        <div>
          <Typography.Title level={5}>审批</Typography.Title>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="决定">{approval.decision}</Descriptions.Item>
            <Descriptions.Item label="审批人">{approval.decidedBy ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="时间">
              {approval.decidedAt ? formatTime(approval.decidedAt) : '—'}
            </Descriptions.Item>
          </Descriptions>
        </div>
      )}

      <div>
        <Typography.Title level={5}>生命周期</Typography.Title>
        {audit.length === 0 ? (
          <Typography.Text type="secondary">没有审计事件</Typography.Text>
        ) : (
          <Timeline
            items={audit.map((event) => ({
              color: BAD_EVENTS.has(event.event) ? 'red' : 'blue',
              children: (
                <Space direction="vertical" size={0}>
                  <Typography.Text>
                    {EVENT_LABEL[event.event]}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      · {event.actorType}/{event.actorId} · {formatTime(event.createdAt)}
                    </Typography.Text>
                  </Typography.Text>
                  {event.detail && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {event.detail}
                    </Typography.Text>
                  )}
                </Space>
              ),
            }))}
          />
        )}
      </div>

      <div>
        <Typography.Title level={5}>导出</Typography.Title>
        <Space>
          <Button
            size="small"
            href={api.executionAuditExportUrl(command.executionId)}
            target="_blank"
          >
            导出这一轮 execution 的审计（JSON）
          </Button>
        </Space>
      </div>

      <div>
        <Typography.Title level={5}>执行尝试</Typography.Title>
        {attempts.length === 0 ? (
          <Typography.Text type="secondary">
            还没有真正打出去过 —— 它停在审批，或者在碰外部系统之前就被挡下了。
          </Typography.Text>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={attempts}
            columns={[
              { title: '第几次', dataIndex: 'attemptNo', width: 72 },
              {
                title: '结果',
                dataIndex: 'status',
                width: 96,
                render: (value: CommandAttemptStatus) => (
                  <Tag color={ATTEMPT_META[value].color}>{ATTEMPT_META[value].label}</Tag>
                ),
              },
              {
                title: '开始',
                dataIndex: 'startedAt',
                width: 170,
                render: (value: string) => formatTime(value),
              },
              {
                title: '说明',
                dataIndex: 'error',
                render: (value: string | null) =>
                  value ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {value}
                    </Typography.Text>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        )}
      </div>

      {(command.status === 'policy_pending' ||
        command.status === 'approved' ||
        command.status === 'ready') && (
        <Space>
          {command.status === 'policy_pending' && (
            <Button type="primary" loading={busyId === command.id} onClick={() => void onAct(command.id, 'approve')}>
              批准并执行
            </Button>
          )}
          {(command.status === 'approved' || command.status === 'ready') && (
            <Button type="primary" loading={busyId === command.id} onClick={() => void onAct(command.id, 'execute')}>
              执行
            </Button>
          )}
          {command.status === 'policy_pending' && (
            <Button danger loading={busyId === command.id} onClick={() => void onAct(command.id, 'reject')}>
              驳回
            </Button>
          )}
        </Space>
      )}
    </Space>
  );
}

/** 本地时间。ISO 串直接显示会让人自己换算时区。 */
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
