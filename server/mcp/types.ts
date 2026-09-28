import type { ToolRisk } from '../capabilities/types.js';

export type McpServerType = 'local' | 'http' | 'sse';

export interface McpToolPolicy {
  risk: ToolRisk;
}

/**
 * 一个 MCP Server 的**定义**（连接方式 + 工具 allowlist），不是运行实例。
 *
 * 运行与工具调用全部交给 Copilot SDK（sessionConfig.mcpServers）：这里只做
 * 「哪个 server 有哪些工具、每个工具什么 risk」，不实现 MCP 协议，也不维护
 * session / 连接池 —— 另一套 Agent Runtime 不会出现。
 *
 * 定义只出现一次（`config/mcp-servers.json`），三层能力（global / team /
 * member）只写「引用 + 选了哪些工具」。定义与授权绑定分开：前者说「怎么连」，
 * 后者说「谁可以用」。
 */
export interface McpServerDefinition {
  id: string;
  displayName: string;
  description?: string;
  type: McpServerType;
  /** remote（http / sse）必填，支持 ${ENV} 引用（token 只放环境变量）。 */
  url?: string;
  headers?: Record<string, string>;
  /** local 必填：SDK 在服务机器上起子进程，默认关闭（见 MCP_LOCAL_ENABLED）。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  /**
   * 允许暴露的工具（显式 allowlist）。不支持 `*`：多给一个工具就是多一次
   * 外部调用，默认全开等于把授权判断外包给远端 server。
   */
  tools: Record<string, McpToolPolicy>;
  /** 进 capability manifest：换了定义（增删工具、改 risk）必须能被审计出来。 */
  version: string;
  /**
   * 开关。文件里不写（缺省=开）：开关是运行时状态，只活在 DB 行里。
   * 关掉后 resolver 直接跳过这个 server，本轮用不到它（会有一次警告）。
   */
  enabled?: boolean;
}
