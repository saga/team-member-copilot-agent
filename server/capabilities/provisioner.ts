import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MemberCapabilities } from '../domain.js';
import type { CapabilityResolver } from './resolver.js';
import type { CapabilityService } from './service.js';

/**
 * global / team 两层能力的 provisioning。
 *
 * 它回答的问题和 `member-template-seeder.ts` 是同一个形状：
 *
 *   磁盘上的这份配置，对应的 scope 是不是已经初始化过了？
 *
 * 判据落在 `capability_scope`（见 CapabilityService.provision），不是「binding
 * 表里有没有行」—— 后者区分不出「从没配过」和「配过但被清空了」，于是管理员
 * 清空 global 之后重启，默认值又会自己长回来。
 *
 * ── 为什么配置在磁盘而不是代码里 ──────────────────────────────────────
 *
 * 这三层能力的**内容**是部署决策（这个公司默认给大家哪些工具、这个团队共享
 * 哪些资料源），不是协议。写进 TypeScript 的话，改一次默认能力要重新构建、
 * 重新发版；放在 `config/capability-templates/` 里，它就是一个可挂载的
 * ConfigMap —— 和 member template 同一种性质。
 *
 * ── 校验先于落库 ──────────────────────────────────────────────────────
 *
 * 一个拼错的 providerId 必须在启动时就让服务起不来，而不是等某个 Member 跑
 * 第一轮时才发现「它少了检索能力」—— 那时错误表现为一个奇怪的回答，而不是
 * 一条错误。
 */
export class CapabilityProvisioner {
  constructor(
    private readonly service: CapabilityService,
    private readonly resolver: CapabilityResolver,
    private readonly rootDirectory: string,
  ) {}

  /** 公司级基线：所有 Agent 默认继承。 */
  seedGlobal(): boolean {
    const capabilities = this.read('global.json');
    this.resolver.validate(capabilities);

    return this.service.provision('global', '', 'capability.global.v1', capabilities);
  }

  /** Team 级基线：Team 内所有 Agent 继承。 */
  seedTeam(teamId: string): boolean {
    const capabilities = this.read('team.json');
    this.resolver.validate(capabilities);

    return this.service.provision('team', teamId, 'capability.team.v1', capabilities);
  }

  private read(filename: string): MemberCapabilities {
    const file = path.join(this.rootDirectory, filename);

    if (!fs.existsSync(file)) {
      throw new Error(`Capability provisioning 配置不存在：${file}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `Capability provisioning 配置不是合法 JSON：${file}（${(error as Error).message}）`,
      );
    }

    const parsed = capabilitiesSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Capability provisioning 配置不合法：${file}（${detail}）`);
    }

    return parsed.data;
  }
}

const bindingSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  /** Provider 自己解释的选择子（knowledge 常用；skill / tool 通常不写）。 */
  selector: z.string().max(300).optional(),
});

const capabilitiesSchema = z.object({
  skills: z.array(bindingSchema).max(100),
  knowledge: z.array(bindingSchema).max(100),
  tools: z.array(bindingSchema).max(100),
});
