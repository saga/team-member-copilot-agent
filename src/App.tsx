import { ConfigProvider, Layout, Space, theme } from 'antd';
import { HealthBadge } from './components/HealthBadge';
import { TeamChat } from './components/TeamChat';

const { Header, Content } = Layout;

export default function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <Layout className="app-shell">
        <Header className="app-header">
          <Space>
            <span className="app-header-title">Team Member Copilot Agent</span>
            <span className="app-header-sub">Member → Conversation → Runtime → Copilot Session</span>
          </Space>
          <HealthBadge />
        </Header>
        <Content style={{ minHeight: 0 }}>
          <TeamChat />
        </Content>
      </Layout>
    </ConfigProvider>
  );
}
