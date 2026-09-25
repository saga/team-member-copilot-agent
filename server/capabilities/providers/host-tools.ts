import type { CapabilityBinding } from '../../domain.js';
import type { RuntimeTool, ToolProvider, ToolProviderContext } from '../types.js';

/**
 * 会触达宿主机的 built-in 工具。
 *
 * 它们的工作目录是 conversation workspace，但 runtime 仍然是宿主机上的进程 ——
 * 没有沙箱时 `bash` 能走到 workspace 之外。所以这一组不是「能力」，是**部署
 * 前提**：四个都带 `requiresHostAccess`，部署层没放行（HOST_CODING_TOOLS）时就
 * 连声明都不该给出去。
 *
 * 为什么 grep / web_fetch 也算 `requiresHostAccess`：它们的 risk 各不相同
 * （读宿主文件 / 出网），但**放行条件**是同一个 —— 需要宿主机。把 risk 和
 * 「要不要宿主」拆成两个字段，就是为了让「grep 比 bash 温和」这件事体现在
 * risk 上，而不体现在「它能不能绕过部署开关」上。
 *
 * ── 为什么用字符串字面量而不是 BuiltInTools.Xxx ────────────────────────
 *
 * SDK 只导出了 `BuiltInTools.Isolated` 这一个集合，没有逐个工具名的常量。
 * 名字来自 SDK 的运行时契约（写错就是「声明了一个不存在的工具」，模型不会看到
 * 它），所以它们是这层唯一合理的硬编码 —— 而它们在这里是**声明**，
 * policy 仍然只读 risk / requiresHostAccess。
 */
const HOST_BUILTINS: ReadonlyArray<{
  name: string;
  description: string;
  risk: RuntimeTool['risk'];
}> = [
  { name: 'bash', description: 'Execute shell commands.', risk: 'host-execution' },
  { name: 'edit', description: 'Edit files.', risk: 'host-execution' },
  { name: 'grep', description: 'Search files.', risk: 'read' },
  { name: 'web_fetch', description: 'Fetch web content.', risk: 'external-write' },
];

export class HostCodingToolProvider implements ToolProvider {
  readonly id = 'runtime.host-coding-tools';
  readonly version = '1';

  async resolve(
    _context: ToolProviderContext,
    _binding: CapabilityBinding,
  ): Promise<RuntimeTool[]> {
    return HOST_BUILTINS.map((tool) => ({
      providerId: this.id,
      kind: 'builtin' as const,
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      requiresHostAccess: true,
    }));
  }
}

/** 供授权层与用例引用的宿主工具名集合（与上面同一份清单，不重复声明）。 */
export const HOST_BUILTIN_NAMES: readonly string[] = HOST_BUILTINS.map((tool) => tool.name);
