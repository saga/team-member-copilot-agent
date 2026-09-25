import { useEffect, useState } from 'react';
import { Badge, Tooltip } from 'antd';
import { api, type Health } from '../lib/api';

export function HealthBadge() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive) setHealth(h);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!health) return <Badge status="processing" text={<span style={{ color: '#fff' }}>连接检查中…</span>} />;
  if (health.copilot === 'connected') {
    return <Badge status="success" text={<span style={{ color: '#fff' }}>Copilot 已连接</span>} />;
  }
  if (health.copilot === 'idle') {
    return (
      <Tooltip title="首个会话时建连">
        <Badge status="warning" text={<span style={{ color: '#fff' }}>Copilot 待连接</span>} />
      </Tooltip>
    );
  }
  return (
    <Tooltip title={health.copilotError ?? 'unknown'}>
      <Badge status="error" text={<span style={{ color: '#fff' }}>Copilot 连接失败</span>} />
    </Tooltip>
  );
}
