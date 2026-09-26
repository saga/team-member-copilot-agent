import { useState } from 'react';
import { Button, DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { api, type Conversation, type Member } from '../../lib/api';

/**
 * Schedule 创建表单。第一版只做「需要做什么」：
 * Member / Conversation / Prompt / 类型 / 时间。不做 Calendar、cron 表达式、
 * 时区编辑器、recurrence designer —— 后端也只支持 once + interval，
 * UI 比后端复杂只会造出填不进去的字段。
 */
export function ScheduleForm({
  members,
  conversations,
  onCreated,
}: {
  members: Member[];
  conversations: Conversation[];
  onCreated: () => void;
}) {
  const [memberId, setMemberId] = useState<string>();
  const [conversationId, setConversationId] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [type, setType] = useState<'once' | 'interval'>('once');
  const [runAt, setRunAt] = useState<dayjs.Dayjs | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState<number>(3600);
  const [busy, setBusy] = useState(false);

  // Schedule 只绑 work 房间：别的 kind 建了也跑不了（后端同样拒绝）。
  const workRooms = conversations.filter((c) => c.kind === 'work');

  async function submit() {
    if (!memberId || !conversationId || !prompt.trim() || !runAt) return;
    setBusy(true);
    try {
      await api.createSchedule({
        memberId,
        conversationId,
        prompt: prompt.trim(),
        type,
        runAt: runAt.toISOString(),
        ...(type === 'interval' ? { intervalSeconds } : {}),
      });
      setPrompt('');
      setRunAt(null);
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  const ready = !!(memberId && conversationId && prompt.trim() && runAt && (type === 'once' || intervalSeconds > 0));

  return (
    <Space direction="vertical" size={6} style={{ width: '100%', marginBottom: 8 }}>
      <Space.Compact style={{ width: '100%' }}>
        <Select
          style={{ minWidth: 130 }}
          placeholder="Member"
          value={memberId}
          onChange={setMemberId}
          options={members.filter((m) => m.status === 'active').map((m) => ({ value: m.id, label: m.name }))}
        />
        <Select
          style={{ minWidth: 150, maxWidth: 220 }}
          placeholder="Work conversation"
          value={conversationId}
          onChange={setConversationId}
          options={workRooms.map((c) => ({ value: c.id, label: c.title }))}
        />
        <Select
          style={{ minWidth: 100 }}
          value={type}
          onChange={setType}
          options={[
            { value: 'once', label: 'Once' },
            { value: 'interval', label: 'Interval' },
          ]}
        />
      </Space.Compact>
      <Input.TextArea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Prompt：到点要 Agent 做什么"
        autoSize={{ minRows: 1, maxRows: 4 }}
      />
      <Space.Compact style={{ width: '100%' }}>
        <DatePicker
          showTime
          style={{ flex: 1 }}
          value={runAt}
          onChange={(value) => setRunAt(value)}
          placeholder="Run at（必须在未来）"
        />
        {type === 'interval' && (
          <Select
            style={{ minWidth: 120 }}
            value={intervalSeconds}
            onChange={setIntervalSeconds}
            options={[
              { value: 60, label: '每分钟' },
              { value: 300, label: '每 5 分钟' },
              { value: 3600, label: '每小时' },
              { value: 86400, label: '每天' },
            ]}
          />
        )}
        <Button type="primary" onClick={() => void submit()} disabled={!ready} loading={busy}>
          Add
        </Button>
      </Space.Compact>
    </Space>
  );
}
