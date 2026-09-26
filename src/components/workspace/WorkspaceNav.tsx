import { Button, Tooltip } from 'antd';
import { MessageOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons';

export type WorkspaceView = 'chat' | 'team' | 'settings';

/**
 * 窄导航 Rail：工作面 / 管理面 / 设置的三选一。
 *
 * 只有三个固定入口，不随 Team 内容变化 —— 它回答「我现在在哪一层」，
 * 而第二列（会话列表 / 成员管理 / 能力配置）回答「这一层里看什么」。
 * 两层各管各的，左边就不会再同时出现 Members、Work、Schedules、
 * Conversations 四个不同层次的东西。
 */
export function WorkspaceNav({
  view,
  onChange,
}: {
  view: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}) {
  const items: Array<{ key: WorkspaceView; label: string; icon: React.ReactNode }> = [
    { key: 'chat', label: 'Chat（日常对话）', icon: <MessageOutlined /> },
    { key: 'team', label: 'Team（成员 / Work / Schedules）', icon: <TeamOutlined /> },
    { key: 'settings', label: 'Settings（Capabilities）', icon: <SettingOutlined /> },
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
