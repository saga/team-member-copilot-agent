import fs from 'node:fs';
import path from 'node:path';
import { hashText } from '../../content-hash.js';
import type { CapabilityBinding } from '../../domain.js';
import type { CapabilityContext, SkillArtifact, SkillProvider } from '../types.js';

/**
 * 磁盘目录即 skill 的 Provider。
 *
 * 三个实例共用这一个类，只是 root 不同（对应能力的三层）：
 *
 *   global.filesystem-skills   <globalSkillRoot>            公司级，所有 Agent 默认继承
 *   team.filesystem-skills     <teamSkillRoot>/<teamId>     Team 级，Team 内所有 Agent 继承
 *   member.filesystem-skills   <memberHomeRoot>/<id>/skills 这个 Member 自己的专长
 *
 * selector 为空 = 当前 scope 下的全部 skill；selector 有值 = 只加载点名的那些。
 *
 * 为什么 root 是 `string | (context) => string` 而不是三个类：唯一的差别就是
 * 「目录怎么算」，而 team / member 目录要跟着 context 走。复制三个类出来，只会
 * 让它们开始各自漂移（比如一个加了 frontmatter 解析，另一个没有）。
 *
 * ── 缺文件时跳过而不是抛 ──────────────────────────────────────────────
 *
 * `SKILL.md` 是这份目录的契约，但这类目录是「放进去就生效」的运维界面。一个
 * 不完整目录如果让 resolve 抛错，后果是**这个 Member 从此一个 turn 都跑不了**
 * （连「帮我看下这句话」都不行）；跳过它的后果只是这个 skill 不在模型眼前，
 * 而且日志里有明确一行。代价完全不对称，所以选择跳过。
 *
 * 这和不静默跳过「模板目录里的坏 JSON」不矛盾：模板是**部署配置**（被读到的
 * 每一个人都由它定义），skill 目录是**内容投放点**（多一个少一个不影响
 * Member 是否存在）。
 */
export class FilesystemSkillProvider implements SkillProvider {
  readonly version = '1';

  constructor(
    public readonly id: string,
    private readonly root: string | ((context: CapabilityContext) => string),
  ) {}

  async resolve(context: CapabilityContext, binding: CapabilityBinding): Promise<SkillArtifact[]> {
    const root = typeof this.root === 'function' ? this.root(context) : this.root;
    if (!fs.existsSync(root)) return [];

    // selector 为空 = 全部；否则只加载点名的 skill（逗号/空白分隔）。
    // binding 看起来细粒度、实际全量返回等于没有边界，所以这里必须真的过滤。
    const only = parseSkillSelector(binding.selector);
    const artifacts: SkillArtifact[] = [];

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (only && !only.has(entry.name)) continue;

      const directory = path.join(root, entry.name);
      const skillFile = path.join(directory, 'SKILL.md');

      if (!fs.existsSync(skillFile)) {
        // eslint-disable-next-line no-console
        console.warn(`[capability] 跳过 ${this.id} 下的 ${entry.name}：缺少 SKILL.md（${directory}）`);
        continue;
      }

      const content = fs.readFileSync(skillFile, 'utf8');
      artifacts.push({
        providerId: this.id,
        name: entry.name,
        description: readDescription(content),
        directory,
        // skill 是 bundle：SKILL.md 之外 scripts/ references/ templates/ 变了也要换版本，
        // 否则 execution 审计看到的是同一个版本、跑的却是两份实现。
        version: hashSkillDirectory(directory),
      });
    }

    if (only) {
      for (const name of only) {
        if (!artifacts.some((artifact) => artifact.name === name)) {
          // eslint-disable-next-line no-console
          console.warn(`[capability] ${this.id} 没有名为 ${name} 的 skill（selector 指向了不存在的目录）`);
        }
      }
    }

    return artifacts.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * selector 语义：空 = 全部；否则是 skill 目录名清单（逗号/空白分隔）。
 *
 * 逗号与空白都认：模板里写 `research, security-review` 与 `research security-review`
 * 都是同一件事，不值得为分隔符定第二种语法。
 */
function parseSkillSelector(selector: string | undefined): Set<string> | null {
  if (!selector?.trim()) return null;
  const names = selector
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

/**
 * 整个 skill 目录的指纹：相对路径 + 文件内容逐个拼接后 hash。
 *
 * 按路径排序保证稳定性；读失败的文件直接跳过 —— 一个坏掉的附件不该让整个
 * skill 在解析阶段消失（SKILL.md 缺失仍跳过，见 resolve）。
 */
function hashSkillDirectory(directory: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) files.push(full);
    }
  };
  walk(directory);
  files.sort();

  const payload: string[] = [];
  for (const full of files) {
    const relative = path.relative(directory, full).split(path.sep).join('/');
    try {
      payload.push(`${relative}\0${fs.readFileSync(full, 'utf8')}\0`);
    } catch {
      continue;
    }
  }
  return hashText(payload.join(''));
}

/**
 * 从 SKILL.md 里取一句描述：优先 YAML frontmatter 的 `description:`，
 * 否则退回到第一个非标题段落。纯文本启发式 —— 它只是清单里的一行说明，
 * 不值得为它引入一个 YAML parser。
 */
function readDescription(content: string): string {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (frontmatter) {
    const line = frontmatter[1]
      .split(/\r?\n/)
      .find((row) => /^\s*description\s*:/i.test(row));
    if (line) {
      return line.replace(/^\s*description\s*:/i, '').trim().replace(/^["']|["']$/g, '').slice(0, 200);
    }
  }

  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const paragraph = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));

  return (paragraph ?? '').slice(0, 200);
}
