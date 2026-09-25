import type { MemberCapabilities } from '../domain.js';

/**
 * 新建 / 手工创建 Member 的默认能力组成。
 *
 * 放在代码里而不是模板目录里，是因为它是**协议层**的默认值：任何一个 Member
 * 至少要有「团队 skill + 个人 skill + 个人资料库 + 协作工具 + 检索工具」，
 * 否则它连一个正常的 turn 都跑不起来。具体是哪个角色、绑定哪些企业资料，
 * 那是模板（provisioning baseline）的事。
 *
 * 宿主工具刻意**不在**默认值里：`runtime.host-coding-tools` 会触达宿主机，
 * 只有明确需要它的角色（比如 Engineer）才绑定，而且即使绑了也还要部署层放行。
 */
export const DEFAULT_MEMBER_CAPABILITIES: MemberCapabilities = {
  skills: [
    { providerId: 'team.filesystem-skills' },
    { providerId: 'member.filesystem-skills' },
  ],
  knowledge: [
    {
      providerId: 'local.filesystem-knowledge',
      selector: '$personal',
    },
  ],
  tools: [
    { providerId: 'team.core-tools' },
    { providerId: 'knowledge.tools' },
  ],
};

/** 深拷贝一份默认能力，避免调用方拿到共享引用后原地改坏它。 */
export function defaultMemberCapabilities(): MemberCapabilities {
  return structuredClone(DEFAULT_MEMBER_CAPABILITIES);
}
