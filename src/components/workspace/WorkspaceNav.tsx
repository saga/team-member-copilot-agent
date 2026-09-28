import { Button, Tooltip } from 'antd';
import {
  AuditOutlined,
  SettingOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';

export type WorkspaceView = 'tasks' | 'team' | 'approvals' | 'settings';

/**
 * 窄导航 Rail：工作面 / 管理面 / 审批 / 设置的四选一。
 *
 * 只有四个固定入口，不随 Team 内容变化 —— 它回答「我现在在哪一层」，
 * 而第二列（工作区列表 / 成员管理 / 能力配置）回答「这一层里看什么」。
 * 两层各管各的，左边就不会再同时出现 Members、Work、Schedules、
 * Conversations 四个不同层次的东西。
 *
 * 审批（Approvals）是独立一层而不是 Team 页的一个区块：它回答的是
 * 「有什么外部写入在等我批」—— 一个**待办**，不是一份名单。混进管理面
 * 会让它变成「需要主动去看一眼」的东西，而待审批是需要被看见的。
 */
export function WorkspaceNav({
  view,
  onChange,
}: {
  view: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}) {
  const items: Array<{ key: WorkspaceView; label: string; icon: React.ReactNode }> = [
    { key: 'tasks', label: 'Tasks', icon: <UnorderedListOutlined /> },
    { key: 'team', label: 'Team', icon: <TeamOutlined /> },
    { key: 'approvals', label: 'Approvals', icon: <AuditOutlined /> },
    { key: 'settings', label: 'Settings', icon: <SettingOutlined /> },
  ];

  return (
    <div
      style={{
        width: 56,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        paddingTop: 12,
        borderRight: '1px solid #f0f0f0',
        background: '#fafafa',
      }}
    >
      {items.map((item) => (
        <Tooltip key={item.key} title={item.label} placement="right">
          <Button
            type={view === item.key ? 'primary' : 'text'}
            shape="circle"
            size="large"
            icon={item.icon}
            aria-label={item.label}
            onClick={() => onChange(item.key)}
          />
        </Tooltip>
      ))}
    </div>
  );
}
