import fs from 'node:fs';
import path from 'node:path';
import { hashText } from '../../content-hash.js';
import type { CapabilityBinding } from '../../domain.js';
import type { CapabilityContext, SkillArtifact, SkillProvider } from '../types.js';

/**
 * 磁盘目录即 skill 的 Provider。
 *
 * 两个实例共用这一个类，只是 root 不同：
 *
 *   team.filesystem-skills     <teamSkillRoot>              全员都该会的程序化方法论
 *   member.filesystem-skills   <member home>/<id>/skills/   这个 Member 自己的专长
 *
 * 为什么 root 是 `string | (context) => string` 而不是两个类：唯一的差别就是
 * 「目录怎么算」，而个人目录要跟着 context 走。复制一个类出来，只会让两边开始
 * 各自漂移（比如一边加了 frontmatter 解析，另一边没有）。
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

  async resolve(context: CapabilityContext, _binding: CapabilityBinding): Promise<SkillArtifact[]> {
    const root = typeof this.root === 'function' ? this.root(context) : this.root;
    if (!fs.existsSync(root)) return [];

    const artifacts: SkillArtifact[] = [];

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

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
        version: hashText(content),
      });
    }

    return artifacts.sort((a, b) => a.name.localeCompare(b.name));
  }
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
