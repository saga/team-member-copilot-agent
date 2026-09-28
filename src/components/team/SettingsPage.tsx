import { Tabs } from 'antd';
import { CapabilitySettings } from './CapabilitySettings';
import { McpServerSettings } from './McpServerSettings';
import type { SettingsSection } from '../../lib/router';

interface SettingsPageProps {
  route: {
    section: SettingsSection;
    scope: 'global' | 'team' | 'member';
    memberId: string | null;
  };
  navigate: (
    next: {
      view: 'settings';
      section: SettingsSection;
      scope: 'global' | 'team' | 'member';
      memberId: string | null;
    },
    options?: { replace?: boolean },
  ) => void;
}

/**
 * Settings 页：Capabilities（谁能用什么）与 MCP Servers（有哪些连接）是两件事。
 *
 * 前者回答授权，后者回答连接定义 —— 共用一个页面会让人以为「在这里勾了工具
 * 就等于配好了 server」。URL 上也是两段：`/settings/...` 与 `/settings/mcp`。
 */
export function SettingsPage({ route, navigate }: SettingsPageProps) {
  return (
    <div style={{ padding: '12px 18px', height: '100%', overflowY: 'auto' }}>
      <Tabs
        activeKey={route.section ?? 'capabilities'}
        onChange={(key) => {
          if (key === 'mcp') {
            navigate({ view: 'settings', section: 'mcp', scope: 'global', memberId: null });
          } else {
            navigate({
              view: 'settings',
              section: 'capabilities',
              scope: route.scope,
              memberId: route.memberId,
            });
          }
        }}
        items={[
          {
            key: 'capabilities',
            label: 'Capabilities',
            children: (
              <CapabilitySettings
                key={`${route.scope}:${route.memberId ?? ''}`}
                inline
                initialScope={route.scope}
                initialMemberId={route.memberId}
                onTargetChange={(scope, memberId) =>
                  navigate(
                    {
                      view: 'settings',
                      section: 'capabilities',
                      scope,
                      memberId,
                    },
                    { replace: true },
                  )
                }
                onClose={() => {}}
              />
            ),
          },
          {
            key: 'mcp',
            label: 'MCP Servers',
            children: <McpServerSettings />,
          },
        ]}
      />
    </div>
  );
}
