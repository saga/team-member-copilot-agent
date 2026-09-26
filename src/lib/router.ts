import { useCallback, useEffect, useState } from 'react';

/**
 * 前端路由：视图 + 关键上下文（当前会话 / 能力配置对象）进 URL。
 *
 * 只有三类路径，不值得为它引 react-router —— 一个 parse + 一个 serialize
 * 加一个 popstate 监听就是这个应用需要的全部。模态框（新建讨论 / 编辑档案）
 * 是瞬态的，不进 URL。
 *
 *   /chat                     工作面，未选会话
 *   /chat/:conversationId     工作面，打开指定会话（可深链 / 刷新恢复）
 *   /team                     管理面
 *   /settings                 能力配置，公司默认
 *   /settings/team            能力配置，团队默认
 *   /settings/member/:id      能力配置，指定成员的增量
 */
export type Route =
  | { view: 'chat'; conversationId: string | null }
  | { view: 'team' }
  | { view: 'settings'; scope: 'global' | 'team' | 'member'; memberId: string | null };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'team') return { view: 'team' };
  if (parts[0] === 'settings') {
    if (parts[1] === 'member') {
      return { view: 'settings', scope: 'member', memberId: parts[2] ?? null };
    }
    if (parts[1] === 'team') return { view: 'settings', scope: 'team', memberId: null };
    return { view: 'settings', scope: 'global', memberId: null };
  }
  // /chat/:id 之外的任何路径（含 / 和打错的）都落回 chat，不做硬 404：
  // 这是单页工具，不是内容站点，把人送回工作面比给他一张 404 页有用。
  if (parts[0] === 'chat' && parts[1]) return { view: 'chat', conversationId: parts[1] };
  return { view: 'chat', conversationId: null };
}

export function routeToPath(route: Route): string {
  switch (route.view) {
    case 'team':
      return '/team';
    case 'settings':
      if (route.scope === 'member') {
        return route.memberId ? `/settings/member/${route.memberId}` : '/settings/member';
      }
      return route.scope === 'team' ? '/settings/team' : '/settings';
    case 'chat':
      return route.conversationId ? `/chat/${route.conversationId}` : '/chat';
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
