import type { DatabaseSync } from 'node:sqlite';

/**
 * 跨 service 的共享事务深度追踪。
 *
 * 为什么不用各 service 自己的 boolean 标志：一次业务动作经常横跨两个 service
 * （例如 claim 要同时写 work_item、execution 和事件表），如果两个 service 各自
 * `BEGIN`，嵌套调用就会撞上 SQLite 的「cannot start a transaction within a
 * transaction」。深度追踪让嵌套调用变成普通函数调用，COMMIT 只由最外层负责。
 *
 * `node:sqlite` 是同步 API：`fn` 里绝不能出现 `await`，否则事务会跨过事件循环
 * 边界，别的请求能挤进 BEGIN/COMMIT 之间 —— 那不是事务，是陷阱。
 */

interface TxState {
  depth: number;
  /** COMMIT 成功后按注册顺序执行；ROLLBACK 则全部丢弃。 */
  hooks: Array<() => void>;
}

const states = new WeakMap<DatabaseSync, TxState>();

function stateOf(db: DatabaseSync): TxState {
  let state = states.get(db);
  if (!state) {
    state = { depth: 0, hooks: [] };
    states.set(db, state);
  }
  return state;
}

export function isInTransaction(db: DatabaseSync): boolean {
  return stateOf(db).depth > 0;
}

/**
 * 在事务里执行 `fn`。已处于事务中（嵌套）就只执行函数体、登记 commit hook；
 * 否则真正 BEGIN/COMMIT，并在 COMMIT 成功后执行期间注册的全部 hook。
 *
 * hook 的典型用途是「COMMIT 之后才广播」：事务里的事情还没做完，广播出去的
 * 状态一旦回滚就是 DB 从没承认过的。hook 在 COMMIT 之后、函数返回之前同步执行。
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T, onCommit?: () => void): T {
  const state = stateOf(db);

  if (state.depth > 0) {
    if (onCommit) state.hooks.push(onCommit);
    return fn();
  }

  state.depth += 1;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    state.depth -= 1;
    const hooks = state.hooks;
    state.hooks = [];
    for (const hook of hooks) hook();
    return result;
  } catch (error) {
    state.depth -= 1;
    state.hooks = [];
    db.exec('ROLLBACK');
    throw error;
  }
}
