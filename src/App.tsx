import { ConfigProvider, Layout, Space, theme } from 'antd';
import { HealthBadge } from './components/HealthBadge';
import { Workspace } from './components/Workspace';

const { Header, Content } = Layout;

export default function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <Layout className="app-shell">
        <Header className="app-header">
          <Space>
            <span className="app-header-title">Team Collaboration Agent</span>
          </Space>
          <Space>
            <HealthBadge />
          </Space>
        </Header>
        <Content style={{ minHeight: 0 }}>
          <Workspace />
        </Content>
      </Layout>
    </ConfigProvider>
  );
}
