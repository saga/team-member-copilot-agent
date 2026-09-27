import { badRequest } from './http-error.js';

/** 一个可用模型及其强度等级：数字越大越强。 */
export interface ModelDefinition {
  id: string;
  strength: number;
}

/**
 * 模型策略：Lead 永远用最强模型，普通 Task 只能用低一档的。
 *
 * 这是服务端执行规则，不是 prompt 约定 —— 模型选择只发生在
 * TeamService.executionModel，CopilotService 只接受传进来的 model。
 */
export interface ModelPolicy {
  lead: ModelDefinition;
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
  const parsed = JSON.parse(raw) as unknown;
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
 * 按环境变量拼出策略并校验。失败直接抛 —— 配置错了就拒绝启动，
 * 不能让 Lead 带着一个和 Task 同档的模型跑起来。
 */
export function buildModelPolicy(input: {
  leadModel: string;
  memberModels: string[];
  strengths: Map<string, number>;
}): ModelPolicy {
  const leadId = input.leadModel.trim();
  if (!leadId) throw new Error('Lead 模型不能为空（COPILOT_LEAD_MODEL）');
  const leadStrength = input.strengths.get(leadId);
  if (leadStrength === undefined) {
    throw new Error(`Lead 模型 ${leadId} 在强度表里没有 strength，请补上`);
  }
  if (input.memberModels.length === 0) {
    throw new Error('Member 模型列表不能为空（COPILOT_MEMBER_MODELS）');
  }
  const members = input.memberModels.map((id) => {
    const strength = input.strengths.get(id);
    if (strength === undefined) {
      throw new Error(`Member 模型 ${id} 在强度表里没有 strength，请补上`);
    }
    return { id, strength };
  });
  const policy: ModelPolicy = {
    lead: { id: leadId, strength: leadStrength },
    members,
    defaultMemberModel: members[0].id,
  };
  assertModelPolicy(policy);
  return policy;
}

/** 启动时校验：任何 Member 模型都不能达到 Lead 的强度。 */
export function assertModelPolicy(policy: ModelPolicy): void {
  for (const model of policy.members) {
    if (model.strength >= policy.lead.strength) {
      throw new Error(`模型配置错误：${model.id} 的 strength（${model.strength}）>= Lead 模型 ${policy.lead.id}（${policy.lead.strength}）`);
    }
  }
  if (!policy.members.some((model) => model.id === policy.defaultMemberModel)) {
    throw new Error(`模型配置错误：默认 Member 模型 ${policy.defaultMemberModel} 不在可选列表里`);
  }
}

/**
 * 普通 Task / delegation 用的模型：必须是 Member 列表里的。
 *
 * null/空 = 回落默认 Member 模型。Lead 模型与未知名字一律拒绝 ——
 * 前者是越级，后者是拼错，两种都不能静默放过。
 */
export function resolveMemberModel(policy: ModelPolicy, model: string | null | undefined): string {
  const id = model?.trim() || policy.defaultMemberModel;
  if (id === policy.lead.id) {
    throw badRequest(`不能把 Lead 模型 ${id} 设为普通任务模型：Task 只能用低一档的模型`);
  }
  if (!policy.members.some((item) => item.id === id)) {
    throw badRequest(
      `未知模型 ${id}：可选的是 ${policy.members.map((item) => item.id).join('、')}，留空则用默认的 ${policy.defaultMemberModel}`,
    );
  }
  return id;
}
