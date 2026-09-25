import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MemberCapabilities } from './domain.js';
import type { MemberService } from './member-service.js';
import type { CapabilityResolver } from './capabilities/resolver.js';
import type { CapabilityService } from './capabilities/service.js';

/**
 * Member template provisioning。
 *
 * 这个文件里**不允许出现任何业务内容** —— 没有「架构师应该怎么回答」，也没有
 * 「安全评审要检查哪些项」。它只回答一个问题：
 *
 *   磁盘上的这份模板，对应的 Member 是否已经存在？
 *
 * 具体是谁、写什么 system prompt、初始记忆是什么、引用哪些能力 Provider，全部在
 * 模板目录里。这样以后加一个「合规评审」或者改掉架构师的措辞、给它换一个知识
 * 后端，都不需要动 TypeScript —— 而那正是把三个角色写进 `MemberService` 或
 * migration 里会立刻丢掉的性质。
 *
 * 边界要分清：
 *
 *   config/member-templates/   provisioning baseline（第一次出现时是什么样）
 *   SQLite member              当前真实配置
 *   member_capability_binding  当前能力组成
 *   <member home>/memory/      当前长期记忆
 *
 * 所以**已存在就跳过，且不覆盖**。模板改了一版也不会自动升级已经建好的 Member：
 * 那会把用户手工改过的人设静默换掉。「恢复成模板」是一个需要显式触发的独立功能，
 * 不是启动副作用。
 *
 * ── 为什么这里不再 import 任何 Knowledge 实现 ─────────────────────────
 *
 * 模板说的是「引用哪个 Provider + 哪个 selector」，不是「让 KnowledgeService
 * 去 ensure 一个 personal KB、再按 key 查 id 绑上去」。后者会让模板事实上知道
 * 「我们的后端是 SQLite + 文件系统」—— 换成 Snowflake 就要改 provisioning。
 */

const capabilityBindingSchema = z.object({
  providerId: z.string().min(1).max(200),
  /** Provider 自己解释的选择子（knowledge 常用；skill / tool 通常不写）。 */
  selector: z.string().max(300).optional(),
});

const memberTemplateSchema = z.object({
  /** provisioning identity。唯一、稳定、不由用户修改。 */
  key: z.string().min(1).max(200),
  handle: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  style: z.string().max(2000).default(''),
  /**
   * `null` = 用部署的默认模型（`COPILOT_MODEL`）。
   *
   * 模板刻意不写死模型名：模型是部署决策，写进模板会让「换模型」变成一次
   * 逐模板的文件修改。
   */
  model: z.string().max(100).nullable().default(null),
  systemPromptFile: z.string().min(1).default('SYSTEM_PROMPT.md'),
  memoryFile: z.string().min(1).default('MEMORY.md'),
  /**
   * 能力组成。刻意**不设默认值**：一份模板必须自己说清楚它引用哪些 Provider。
   * 有默认值的话，「新角色忘了写 tools」会静默拿到一组它并不需要的工具，而
   * 这种错误在运行期表现为「模型偶尔调了一个奇怪的东西」。
   *
   * 三类的 providerId 在 seeding 时对注册表校验：写错一个就启动失败，而不是
   * 等到第一个 turn 才发现「这个 Member 少了检索能力」。
   */
  capabilities: z.object({
    skills: z.array(capabilityBindingSchema).max(50),
    knowledge: z.array(capabilityBindingSchema).max(50),
    tools: z.array(capabilityBindingSchema).max(50),
  }),
  /** 关掉一个模板不会删掉已建出来的 Member，只是不再 provision 它。 */
  enabled: z.boolean().default(true),
});

export type MemberTemplate = z.infer<typeof memberTemplateSchema>;

export interface SeedResult {
  /** 这次新建出来的 template key。 */
  created: string[];
  /** 已经有对应 Member、被跳过的 template key。 */
  skipped: string[];
}

/**
 * 读模板目录里的文件，并挡住路径穿越。
 *
 * `systemPromptFile` / `memoryFile` 来自模板自己的 JSON，模板目录又是可能被挂载
 * 进来的外部输入。`"../../etc/passwd"` 这种值必须在这里就拒绝 —— 否则这个函数
 * 会把宿主机上的任意文件读成某个 Member 的 system prompt。
 */
function readTemplateFile(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);

  // 先比相等再比前缀：`path.resolve('/a', './x')` 会落成 `/a/x`，
  // 而 `path.resolve('/a', '')` 会落回 `/a` 本身，两种情况都要能过。
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`模板文件越界（不允许指向模板目录之外）：${relativePath}`);
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`模板文件不存在：${relativePath}`);
  }

  return fs.readFileSync(resolved, 'utf8');
}

function loadTemplate(
  root: string,
  directory: string,
): { template: MemberTemplate; systemPrompt: string; memory: string } {
  const templateRoot = path.join(root, directory);
  const manifestPath = path.join(templateRoot, 'member.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Member template 缺少 member.json：${templateRoot}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Member template 的 member.json 不是合法 JSON：${manifestPath}（${(error as Error).message}）`,
    );
  }

  const parsed = memberTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Member template 不合法：${manifestPath}（${detail}）`);
  }

  return {
    template: parsed.data,
    systemPrompt: readTemplateFile(templateRoot, parsed.data.systemPromptFile).trim(),
    memory: readTemplateFile(templateRoot, parsed.data.memoryFile).trim(),
  };
}

/**
 * 扫描模板目录，把还没出现过的 Member 建出来。
 *
 * 幂等：同一个 `key` 跑多少次都只有第一次会创建。判据落在 `member.seed_key`
 * 上，不是 handle / name。
 *
 * 配置错误**直接抛**，不静默跳过：模板目录里出现一个坏掉的目录，正确行为是让人
 * 在启动日志里立刻看到它，而不是「默认团队少了两个人但服务照常起来了」。
 * 目录本身不存在是另一回事 —— 那说明这份部署不需要模板，返回空即可。
 *
 * 校验顺序是「先验能力、再建人、最后写绑定」：反过来的话，一个拼错的 providerId
 * 会在库里留下一个没有能力的 Member（而它看起来是个正常人）。
 */
export function seedMemberTemplates(
  memberService: MemberService,
  rootDirectory: string,
  capabilities: CapabilityService,
  resolver: CapabilityResolver,
): SeedResult {
  if (!fs.existsSync(rootDirectory)) {
    return { created: [], skipped: [] };
  }

  const directories = fs
    .readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  const created: string[] = [];
  const skipped: string[] = [];
  const seenKeys = new Map<string, string>();

  for (const directory of directories) {
    const { template, systemPrompt, memory } = loadTemplate(rootDirectory, directory);

    if (!template.enabled) continue;

    const previous = seenKeys.get(template.key);
    if (previous) {
      throw new Error(
        `重复的 Member template key：${template.key}（${previous} 与 ${directory}）。` +
          `key 是 provisioning identity，两条模板共用一个 key 会让其中一个永远建不出来。`,
      );
    }
    seenKeys.set(template.key, directory);

    if (memberService.findBySeedKey(template.key)) {
      skipped.push(template.key);
      continue;
    }

    const templateCapabilities: MemberCapabilities = template.capabilities;
    resolver.validate(templateCapabilities);

    const member = memberService.create(
      {
        name: template.name,
        handle: template.handle,
        role: template.role,
        description: template.description,
        style: template.style,
        systemPrompt,
        model: template.model ?? undefined,
      },
      { seedKey: template.key, initialMemory: memory },
    );

    capabilities.replace(member.id, templateCapabilities);

    created.push(template.key);
  }

  return { created, skipped };
}
