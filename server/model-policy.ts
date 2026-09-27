import { badRequest } from './http-error.js';
import type { LeadModelPurpose, ModelPurpose, WakeReason } from './domain.js';

/**
 * 一个可用模型及其强度等级。
 *
 * tier：
 *   strong   = 强推理（只有 Lead 能用）
 *   standard = 常规工作（Lead 默认 + 普通 Member）
 *   cheap    = 简单/机械任务（Member）
 */
export type ModelTier = 'strong' | 'standard' | 'cheap';

export interface ModelDefinition {
  id: string;
  strength: number;
  tier: ModelTier;
}

export interface ModelPolicy {
  lead: {
    strong: ModelDefinition;
    standard: ModelDefinition;
  };
  members: ModelDefinition[];
  defaultMemberModel: string;
}

/** 解析 `a,b,c` 形的模型列表。 */
export function parseModelList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 解析 `{"gpt-5":100,...}` 形的强度表：坏 JSON 直接抛，让启动失败。 */
export function parseModelStrengths(raw: string): Map<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`模型强度表不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('模型强度表必须是对象：{"model-id": strength}');
  }
  const strengths = new Map<string, number>();
  for (const [id, strength] of Object.entries(parsed)) {
    if (typeof strength !== 'number' || !Number.isFinite(strength)) {
      throw new Error(`模型 ${id} 的 strength 必须是数字`);
    }
    strengths.set(id, strength);
  }
  return strengths;
}

/**
 * 根据强度推断 Member 档位：
 *
 *   >= Lead standard strength → standard
 *   <  Lead standard strength → cheap
 *
 * Lead strong 本身单独标成 strong。
 */
function memberTier(strength: number, leadStandardStrength: number): ModelTier {
  return strength >= leadStandardStrength ? 'standard' : 'cheap';
}

function getStrength(id: string, strengths: Map<string, number>): number {
  const strength = strengths.get(id);
  if (strength === undefined) {
    throw new Error(`模型 ${id} 在强度表里没有 strength，请补上`);
  }
  return strength;
}

/**
 * 按环境变量拼出策略并校验。失败直接抛，服务拒绝启动。
 *
 * 强约束：
 *
 *   Lead Strong > Lead Standard >= 所有 Member 模型
 *
 * 于是 Lead 可以 Standard / Strong，Member 只能 Standard / Cheap，
 * Member 绝不会越过 Lead 的 Strong 档。
 */
export function buildModelPolicy(input: {
  strongLeadModel: string;
  standardLeadModel: string;
  memberModels: string[];
  strengths: Map<string, number>;
}): ModelPolicy {
  const strongLeadId = input.strongLeadModel.trim();
  const standardLeadId = input.standardLeadModel.trim();
  if (!strongLeadId) {
    throw new Error('Strong Lead 模型不能为空（COPILOT_LEAD_STRONG_MODEL）');
  }
  if (!standardLeadId) {
    throw new Error('Standard Lead 模型不能为空（COPILOT_LEAD_STANDARD_MODEL）');
  }
  if (input.memberModels.length === 0) {
    throw new Error('Member 模型列表不能为空（COPILOT_MEMBER_MODELS）');
  }

  const strongLeadStrength = getStrength(strongLeadId, input.strengths);
  const standardLeadStrength = getStrength(standardLeadId, input.strengths);
  if (strongLeadStrength <= standardLeadStrength) {
    throw new Error(
      `模型配置错误：Strong Lead ${strongLeadId}（${strongLeadStrength}）必须强于 ` +
        `Standard Lead ${standardLeadId}（${standardLeadStrength}）`,
    );
  }

  const members = input.memberModels.map((id) => {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new Error('Member 模型列表里不能有空模型');
    }
    const strength = getStrength(normalizedId, input.strengths);
    if (strength >= strongLeadStrength) {
      throw new Error(
        `模型配置错误：Member 模型 ${normalizedId}（${strength}）不能达到或超过 ` +
          `Strong Lead ${strongLeadId}（${strongLeadStrength}）`,
      );
    }
    if (strength > standardLeadStrength) {
      throw new Error(
        `模型配置错误：Member 模型 ${normalizedId}（${strength}）高于 ` +
          `Standard Lead ${standardLeadId}（${standardLeadStrength}）；` +
          `Member 模型应该处于 Standard Lead 或更低档`,
      );
    }
    return {
      id: normalizedId,
      strength,
      tier: memberTier(strength, standardLeadStrength),
    } satisfies ModelDefinition;
  });

  const policy: ModelPolicy = {
    lead: {
      strong: { id: strongLeadId, strength: strongLeadStrength, tier: 'strong' },
      standard: { id: standardLeadId, strength: standardLeadStrength, tier: 'standard' },
    },
    members,
    defaultMemberModel: members[0].id,
  };
  assertModelPolicy(policy);
  return policy;
}

/** 启动时校验：Strong > Standard >= 全部 Member，且默认模型在列表里。 */
export function assertModelPolicy(policy: ModelPolicy): void {
  if (policy.lead.strong.strength <= policy.lead.standard.strength) {
    throw new Error(`Strong Lead ${policy.lead.strong.id} 必须强于 Standard Lead ${policy.lead.standard.id}`);
  }
  for (const model of policy.members) {
    if (model.strength >= policy.lead.strong.strength) {
      throw new Error(
        `模型配置错误：${model.id} 的 strength（${model.strength}）>= Strong Lead ` +
          `${policy.lead.strong.id}（${policy.lead.strong.strength}）`,
      );
    }
    if (model.strength > policy.lead.standard.strength) {
      throw new Error(
        `模型配置错误：${model.id} 的 strength（${model.strength}）> Standard Lead ` +
          `${policy.lead.standard.id}（${policy.lead.standard.strength}）`,
      );
    }
  }
  if (!policy.members.some((model) => model.id === policy.defaultMemberModel)) {
    throw new Error(`模型配置错误：默认 Member 模型 ${policy.defaultMemberModel} 不在可选列表里`);
  }
}

/**
 * 普通 Task / delegation 用的模型。
 *
 * Strong Lead 绝不能被普通 Member 使用。Standard Lead 如果同时出现在
 * Member 列表里，则允许作为 Member 的 Standard 模型。
 * null/空 = 回落默认 Member 模型；未知名字直接拒绝。
 */
export function resolveMemberModel(policy: ModelPolicy, model: string | null | undefined): string {
  const id = model?.trim() || policy.defaultMemberModel;
  if (id === policy.lead.strong.id) {
    throw badRequest(`不能把 Strong Lead 模型 ${id} 设为普通任务模型：普通任务只能使用 Standard / Cheap 模型`);
  }
  if (!policy.members.some((item) => item.id === id)) {
    throw badRequest(
      `未知模型 ${id}：可选的是 ${policy.members.map((item) => item.id).join('、')}，` +
        `留空则用默认的 ${policy.defaultMemberModel}`,
    );
  }
  return id;
}

/**
 * Task 执行用的模型。档位由任务定（Lead 在 plan/add 里锁），不是执行人自己定：
 *
 *   null       → 跟执行人默认（Member 配什么用什么）
 *   'strong'   → Strong 模型（复杂任务升级）
 *   'standard' → 该档的 Member 模型
 *   'cheap'    → 该档的 Member 模型
 *
 * 同档没有可选模型时回落默认 Member 模型，不抛错 —— 档位是成本偏好，
 * 不是身份校验，缺货时用默认跑起来比失败强。
 */
export function resolveTaskModel(
  policy: ModelPolicy,
  memberModel: string | null | undefined,
  taskTier: 'cheap' | 'standard' | 'strong' | null | undefined,
): string {
  if (taskTier === 'strong') return policy.lead.strong.id;
  if (taskTier === 'standard' || taskTier === 'cheap') {
    return policy.members.find((item) => item.tier === taskTier)?.id ?? policy.defaultMemberModel;
  }
  return resolveMemberModel(policy, memberModel);
}

/**
 * Lead 这一轮为什么需要某个档位的模型。不通过 LLM 判断，直接由控制面确定性路由。
 *
 * wakeReason 取完整 WakeReason：task_ready / schedule 落到 Lead turn 上时
 * （定时任务、恢复重派）不走特殊分支，按任务状态与用户意图正常判断。
 */
export function classifyLeadTurn(input: {
  wakeReason: WakeReason;
  taskCount: number;
  prompt: string;
}): LeadModelPurpose {
  // 显式原因优先于任务计数：用户刚回答澄清 / 任务刚失败阻塞，
  // 这一轮的性质由触发原因决定，而不是由“有没有 Task”猜。
  if (input.wakeReason === 'lead_clarification') {
    return 'clarification';
  }
  if (input.wakeReason === 'lead_recovery') {
    return 'recovery';
  }
  // 没有 Task 时，Lead 的职责就是理解目标 / 澄清 / 初始规划。
  if (input.taskCount === 0) {
    return 'planning';
  }
  /**
   * 已经有任务，但用户明确要求整体重新判断 / 综合 / 重规划时升级。
   * 这里故意保持保守，不让普通的“现在怎么样了”进入 Strong。
   */
  const strongIntent =
    /重新规划|重新设计|重新拆分|重新拆解|调整任务|改任务分工|总体判断|最终判断|最终方案|综合结果|综合结论|汇总结果|汇总结论|比较方案|比较选择|权衡|重新评估|重新考虑|replan|redesign|rethink|rescope|synthesize|trade.?off|final decision|overall assessment/i;
  if (strongIntent.test(input.prompt)) {
    return 'synthesis';
  }
  return 'routine';
}

/** 按 purpose 选模型：只有 planning / clarification / recovery / synthesis 用 Strong。 */
export function chooseLeadModel(
  policy: ModelPolicy,
  purpose: LeadModelPurpose,
): { model: string; purpose: ModelPurpose } {
  switch (purpose) {
    case 'planning':
      return { model: policy.lead.strong.id, purpose: 'lead:planning' };
    case 'clarification':
      return { model: policy.lead.strong.id, purpose: 'lead:clarification' };
    case 'recovery':
      return { model: policy.lead.strong.id, purpose: 'lead:recovery' };
    case 'synthesis':
      return { model: policy.lead.strong.id, purpose: 'lead:synthesis' };
    case 'routine':
      return { model: policy.lead.standard.id, purpose: 'lead:routine' };
  }
}
