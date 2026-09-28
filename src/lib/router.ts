import { useCallback, useEffect, useState } from 'react';

/**
 * 前端路由：视图 + 关键上下文（当前工作区 / 能力配置对象）进 URL。
 *
 * 只有三类路径，不值得为它引 react-router —— 一个 parse + 一个 serialize
 * 加一个 popstate 监听就是这个应用需要的全部。模态框（新建任务 / 编辑档案）
 * 是瞬态的，不进 URL。
 *
 *   /tasks                  工作面，未选工作区
 *   /tasks/:conversationId  工作面，打开指定工作区（可深链 / 刷新恢复）
 *   /team                   管理面
 *   /approvals              审批收件箱（待审批的外部写入）
 *   /settings               能力配置，公司默认
 *   /settings/team          能力配置，团队默认
 *   /settings/member/:id    能力配置，指定成员的增量
 *   /settings/mcp           MCP Server 连接配置（与能力授权分开）
 *
 * 旧的 /chat/:id 继续解析到工作面（兼容已有链接），但新生成的地址一律用 /tasks。
 */
export type SettingsSection = 'capabilities' | 'mcp';

export type Route =
  | { view: 'tasks'; conversationId: string | null }
  | { view: 'team' }
  | { view: 'approvals' }
  | {
      view: 'settings';
      section: SettingsSection;
      scope: 'global' | 'team' | 'member';
      memberId: string | null;
    };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'team') return { view: 'team' };
  // 审批收件箱：外部写入的放行出口。它有自己的地址而不是做成 Team 页的一个
  // 弹窗 —— 「有一笔等待我批的写入」是要能深链、能刷新后还在的状态。
  if (parts[0] === 'approvals') return { view: 'approvals' };
  if (parts[0] === 'settings') {
    if (parts[1] === 'mcp') {
      return { view: 'settings', section: 'mcp', scope: 'global', memberId: null };
    }
    if (parts[1] === 'member') {
      return { view: 'settings', section: 'capabilities', scope: 'member', memberId: parts[2] ?? null };
    }
    if (parts[1] === 'team') {
      return { view: 'settings', section: 'capabilities', scope: 'team', memberId: null };
    }
    return { view: 'settings', section: 'capabilities', scope: 'global', memberId: null };
  }
  // /tasks/:id 之外的任何路径（含 / 和打错的）都落回 tasks，不做硬 404：
  // 这是单页工具，不是内容站点，把人送回工作面比给他一张 404 页有用。
  // /chat/:id 是旧地址，继续兼容。
  if ((parts[0] === 'tasks' || parts[0] === 'chat') && parts[1]) {
    return { view: 'tasks', conversationId: parts[1] };
  }
  return { view: 'tasks', conversationId: null };
}

export function routeToPath(route: Route): string {
  switch (route.view) {
    case 'team':
      return '/team';
    case 'approvals':
      return '/approvals';
    case 'settings':
      if (route.section === 'mcp') {
        return '/settings/mcp';
      }
      if (route.scope === 'member') {
        return route.memberId ? `/settings/member/${route.memberId}` : '/settings/member';
      }
      return route.scope === 'team' ? '/settings/team' : '/settings';
    case 'tasks':
      return route.conversationId ? `/tasks/${route.conversationId}` : '/tasks';
  }
}

/**
 * 路由状态 + navigate。同一路径的 navigate 是 no-op（切页签、自动同步
 * 都会反复算出相同目标，不挡住的话会塞出一串重复历史）。
 */
export function useRoute(): [
  Route,
  (next: Route, options?: { replace?: boolean }) => void,
] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const path = routeToPath(next);
    if (window.location.pathname === path) return;
    if (options?.replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
