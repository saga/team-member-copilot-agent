import { useEffect, useState } from 'react';
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

  if (!health) return <span className="badge">连接检查中…</span>;
  const cls =
    health.copilot === 'connected'
      ? 'badge badge-ok'
      : health.copilot === 'idle'
        ? 'badge badge-warn'
        : 'badge badge-error';
  const label =
    health.copilot === 'connected'
      ? 'Copilot 已连接'
      : health.copilot === 'idle'
        ? 'Copilot 待连接（首个会话时建连）'
        : `Copilot 连接失败：${health.copilotError ?? 'unknown'}`;
  return <span className={cls}>{label}</span>;
}
