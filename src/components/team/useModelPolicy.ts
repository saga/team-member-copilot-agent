import { useEffect, useState } from 'react';
import { api, type ModelPolicy } from '../../lib/api';

/**
 * 读一次服务端模型策略。
 *
 * 失败时返回 null，调用方按「还没加载」渲染（下拉先空着），而不是拿一份
 * 写死的列表顶上 —— 可选模型是服务端规则，前端猜一份只会和后端打架。
 */
export function useModelPolicy(): ModelPolicy | null {
  const [policy, setPolicy] = useState<ModelPolicy | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getModelPolicy()
      .then((result) => {
        if (alive) setPolicy(result.policy);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return policy;
}
