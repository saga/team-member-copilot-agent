import { useState } from 'react';
import { Button, ConfigProvider, Layout, Space, theme } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { HealthBadge } from './components/HealthBadge';
import { TeamChat } from './components/TeamChat';
import { CapabilitySettings } from './components/team/CapabilitySettings';

const { Header, Content } = Layout;

export default function App() {
  const [showCapabilities, setShowCapabilities] = useState(false);

  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <Layout className="app-shell">
        <Header className="app-header">
          <Space>
            <span className="app-header-title">Team Member Copilot Agent</span>
            <span className="app-header-sub">Member → Conversation → Runtime → Copilot Session</span>
          </Space>
          <Space>
            <Button
              className="app-header-action"
              icon={<SettingOutlined />}
              onClick={() => setShowCapabilities(true)}
            >
              Capabilities
            </Button>
            <HealthBadge />
          </Space>
        </Header>
        <Content style={{ minHeight: 0 }}>
          <TeamChat />
        </Content>
      </Layout>

      {/*
        配置窗口挂在 App 而不是 TeamChat 里：它配的是 global / team / member 三层，
        其中两层与「当前打开哪个房间」无关。挂进聊天容器会把它读成「当前会话的设置」，
        而那正是它最容易被人误会的地方。
      */}
      {showCapabilities && <CapabilitySettings onClose={() => setShowCapabilities(false)} />}
    </ConfigProvider>
  );
}
