/**
 * 首次初始化时 owner 席位给谁。
 *
 * ── 为什么这是一个独立的决策，而不是三行内联代码 ─────────────────────
 *
 * 它决定的是「谁能改这个部署的配置」，而判错的两个方向都是**静默**的：
 *
 *   该拦没拦   → 一个「没有 owner」的 Team 跑起来，谁都改不了 capability
 *                boundary / skill / knowledge，只能改库。而且没有任何地方报错。
 *   拦错了     → 已经在跑的部署每次重启都要求配置 bootstrap owner，运维负担，
 *                于是有人会去随便填一个 —— 而那个身份从此占着 owner 席位。
 *
 * 唯一能被看见的失败是「进程起不来」，所以这一条必须能在启动之前被验证，
 * 而不是等到部署完发现第一个管理员什么都改不了。
 *
 * ── 为什么生产模式不能拿 LOCAL_ACTOR_ID 兜底 ─────────────────────────
 *
 * `localActorId` 是「本机单用户」的占位，生产模式下它**永远不会出现在任何
 * token 上**。拿它建 owner，owner 席位就被一个永远无法登录的身份占着 ——
 * 第一个真正的管理员进来，发现自己什么都改不了，而系统看起来是正常的。
 *
 * 真实用户的 principalId 是 token 里的 `sub`（`auth0|65f3…`），所以生产模式
 * 必须显式配置 `OIDC_BOOTSTRAP_OWNER_SUB`。
 *
 * ── 为什么只在「还没有 owner」时才要求它 ─────────────────────────────
 *
 * 这个配置是一次性的：它只用来播下第一个 owner，之后 owner 由 owner 自己
 * 在界面里管理。要求每次重启都带着它，等于把一次性动作变成一个长期运维负担 ——
 * 而负担越重，越容易被人用一个占位值糊过去。
 */
export interface BootstrapOwnerInput {
  /** dev 模式：用 LOCAL_ACTOR_ID 当 owner（那时它就是唯一的人）。 */
  authDevMode: boolean;
  localActorId: string;
  /** 生产模式下第一个 owner 的 OIDC `sub`。 */
  oidcBootstrapOwnerSub: string;
  /** 这个 Team 现在有没有 active 的 human owner。 */
  hasHumanOwner: boolean;
}

export type BootstrapOwnerDecision =
  /** 已经有 owner 了：什么都不做（重启不该重复播 owner）。 */
  | { kind: 'existing' }
  /** 需要新建一个 owner，用这个身份。 */
  | { kind: 'create'; principalId: string }
  /** 必须有 owner 但拿不到可信身份 —— 调用方应当拒绝启动。 */
  | { kind: 'missing'; reason: string };

/**
 * 用来建 Team 的 `created_by`。
 *
 * 与 `resolveBootstrapOwner` 分开：Team 行必须在「有没有 owner」被问出来之前
 * 就存在，所以这个值要在决策之前算好。它只是记录，不产生权限。
 */
export function configuredBootstrapPrincipal(input: {
  authDevMode: boolean;
  localActorId: string;
  oidcBootstrapOwnerSub: string;
}): string {
  return input.authDevMode ? input.localActorId : input.oidcBootstrapOwnerSub;
}

export function resolveBootstrapOwner(input: BootstrapOwnerInput): BootstrapOwnerDecision {
  if (input.hasHumanOwner) return { kind: 'existing' };

  const principalId = configuredBootstrapPrincipal(input);
  if (principalId) return { kind: 'create', principalId };

  return {
    kind: 'missing',
    reason:
      '首次初始化必须配置 OIDC_BOOTSTRAP_OWNER_SUB（Team 还没有 human owner，' +
      '而生产模式下不能用 LOCAL_ACTOR_ID 充当 owner —— 它永远无法登录，' +
      'owner 席位会被一个不可用的身份占着）',
  };
}
