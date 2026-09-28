import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  configuredBootstrapPrincipal,
  resolveBootstrapOwner,
} from '../bootstrap-owner.js';

/**
 * 首次初始化的 owner 席位 —— 判错的两个方向都是静默的。
 *
 *   该拦没拦 → 一个「没有 owner」的 Team 跑起来。谁都改不了 capability
 *              boundary / skill / knowledge，只能改库，而没有任何地方报错。
 *   拦错了   → 已经在跑的部署每次重启都要求配置 bootstrap owner。运维负担越重，
 *              越容易有人填一个占位值 —— 而那个身份从此占着 owner 席位。
 *
 * 所以下面每一条都在钉「什么时候必须拦、什么时候必须放行」，而不是只测 happy path。
 */

const DEV = { authDevMode: true, localActorId: 'local-user', oidcBootstrapOwnerSub: '' };
const PROD = { authDevMode: false, localActorId: 'local-user', oidcBootstrapOwnerSub: '' };

describe('首次初始化：owner 席位给谁', () => {
  it('dev 模式：用 LOCAL_ACTOR_ID（那时它就是唯一的人）', () => {
    assert.deepEqual(resolveBootstrapOwner({ ...DEV, hasHumanOwner: false }), {
      kind: 'create',
      principalId: 'local-user',
    });
  });

  it('生产模式 + 配了 sub：用它建 owner', () => {
    assert.deepEqual(
      resolveBootstrapOwner({
        ...PROD,
        oidcBootstrapOwnerSub: 'auth0|65f3abc',
        hasHumanOwner: false,
      }),
      { kind: 'create', principalId: 'auth0|65f3abc' },
    );
  });

  it('生产模式 + 没配 sub：拒绝启动，且不许拿 LOCAL_ACTOR_ID 兜底', () => {
    const decision = resolveBootstrapOwner({ ...PROD, hasHumanOwner: false });

    assert.equal(decision.kind, 'missing');
    assert.match(
      (decision as { reason: string }).reason,
      /OIDC_BOOTSTRAP_OWNER_SUB/,
      '报错必须说清楚该配哪个变量',
    );
    // 这是这条规则的全部意义：local-user 永远不出现在任何 token 上，
    // 拿它建 owner 会让 owner 席位被一个**无法登录**的身份占着。
    assert.equal(
      (decision as { reason: string }).reason.includes('永远无法登录'),
      true,
      '理由要写出来，否则运维只会把它当成一个多余的必填项',
    );
  });

  it('已经有 owner：什么都不做，也不要求配置', () => {
    // 已经在跑的部署不该因为少一个 bootstrap 变量而拒绝启动。
    assert.deepEqual(resolveBootstrapOwner({ ...PROD, hasHumanOwner: true }), {
      kind: 'existing',
    });
    // 即使生产模式下什么都没配，只要有 owner 就必须放行。
    assert.equal(resolveBootstrapOwner({ ...PROD, hasHumanOwner: true }).kind, 'existing');
  });

  it('dev 模式有 owner 时同样不动它（重启不能重复播 owner）', () => {
    assert.deepEqual(resolveBootstrapOwner({ ...DEV, hasHumanOwner: true }), {
      kind: 'existing',
    });
  });

  it('created_by 与 owner 判定分开：Team 行要先于这个判定存在', () => {
    // Team 必须在「有没有 owner」被问出来之前就建好，所以这个值要单独算。
    // 它只是记录，不产生权限 —— 混进 owner 判定会让「谁建的 Team」
    // 和「谁是 owner」被绑死，而这两件事之后会分开走。
    assert.equal(configuredBootstrapPrincipal(DEV), 'local-user');
    assert.equal(configuredBootstrapPrincipal(PROD), '');
    assert.equal(
      configuredBootstrapPrincipal({ ...PROD, oidcBootstrapOwnerSub: 'auth0|65f3abc' }),
      'auth0|65f3abc',
    );
  });
});
