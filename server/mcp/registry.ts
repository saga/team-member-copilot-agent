import fs from 'node:fs';
import { z } from 'zod';
import type { McpServerDefinition } from './types.js';

/**
 * MCP Server 定义的加载 + 查询。
 *
 * 只读 `config/mcp-servers.json`，做三件事：`${ENV}` 展开、形状校验、启动期
 * 强约束（坏定义直接抛，服务拒绝启动 —— 和 capability provisioning 同一纪律）。
 * 运行与调用是 SDK 的事，这里没有任何连接状态。
 */

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const toolPolicySchema = z.object({
  risk: z.enum(['read', 'self-write', 'coordination', 'external-read', 'external-write', 'host-execution', 'privileged']),
});

const serverSchema = z
  .object({
    id: z.string().regex(NAME_PATTERN, 'MCP server id 只能是字母数字及 - _，且以字母数字开头'),
    displayName: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    type: z.enum(['local', 'http', 'sse']),
    url: z.string().max(2000).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(500)).max(50).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().max(500).optional(),
    timeout: z.number().int().positive().max(3_600_000).optional(),
    tools: z.record(z.string(), toolPolicySchema),
    version: z.string().trim().min(1).max(100),
  })
  .strict();

const fileSchema = z
  .object({
    servers: z.array(serverSchema).max(100),
  })
  .strict();

export interface McpLoadOptions {
  /** local/stdio server 需要在服务机器上起子进程，默认关闭。 */
  allowLocal: boolean;
}

/**
 * 从 JSON 文件加载 MCP Server 定义。
 *
 * 文件不存在 = 这一层部署没接 MCP：警告一行并返回空，不让整个服务起不来
 * （MCP 是可选能力，和「没配 Jira 就没有工单工具」同一约定）。
 */
export function loadMcpServerDefinitions(filePath: string, options: McpLoadOptions): McpServerDefinition[] {
  if (!fs.existsSync(filePath)) {
    // eslint-disable-next-line no-console
    console.warn(`[mcp] 定义文件不存在：${filePath} —— 本次部署不注册任何 MCP Server`);
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `MCP Server 定义不是合法 JSON：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
    throw new Error(`MCP Server 定义不合法：${filePath}（${detail}）`);
  }

  const seen = new Set<string>();
  return parsed.data.servers.map((server) => {
    if (seen.has(server.id)) {
      throw new Error(`MCP Server id 重复：${server.id}（${filePath}）`);
    }
    seen.add(server.id);
    return normalizeDefinition(server, filePath, options);
  });
}

function normalizeDefinition(
  server: z.infer<typeof serverSchema>,
  filePath: string,
  options: McpLoadOptions,
): McpServerDefinition {
  const toolNames = Object.keys(server.tools);
  if (toolNames.length === 0) {
    throw new Error(`MCP Server ${server.id} 没有声明任何工具：allowlist 为空等于注册了一个寂寞（${filePath}）`);
  }
  for (const name of toolNames) {
    if (name === '*') {
      throw new Error(`MCP Server ${server.id} 不能用 "*" 声明工具：必须显式列出每个工具（${filePath}）`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`MCP Server ${server.id} 的工具名不合法：${name}（${filePath}）`);
    }
  }

  // 先展开再校验必填：引用的环境变量缺失时展开成空串，随后按「缺字段」拒绝，
  // 而不是把 `${TOKEN}` 原样注册进去再发出去。
  const url = server.url === undefined ? undefined : expandEnv(server.url, server.id);
  const command = server.command === undefined ? undefined : expandEnv(server.command, server.id);

  if (server.type === 'local') {
    if (!options.allowLocal) {
      throw new Error(
        `MCP Server ${server.id} 是 local 类型，会在服务机器上启动子进程：` +
          `在服务端设置 MCP_LOCAL_ENABLED=true 后才能注册（${filePath}）`,
      );
    }
    if (!command?.trim()) {
      throw new Error(`MCP Server ${server.id} 缺少 command（${filePath}）`);
    }
  } else {
    if (!url?.trim()) {
      throw new Error(`MCP Server ${server.id} 缺少 url（${filePath}）`);
    }
  }

  return {
    id: server.id,
    displayName: server.displayName,
    ...(server.description === undefined ? {} : { description: server.description }),
    type: server.type,
    ...(url === undefined ? {} : { url }),
    ...(server.headers === undefined ? {} : { headers: expandEnvRecord(server.headers, server.id) }),
    ...(command === undefined ? {} : { command }),
    ...(server.args === undefined ? {} : { args: server.args.map((arg) => expandEnv(arg, server.id)) }),
    ...(server.env === undefined ? {} : { env: expandEnvRecord(server.env, server.id) }),
    ...(server.cwd === undefined ? {} : { cwd: expandEnv(server.cwd, server.id) }),
    ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
    tools: server.tools,
    version: server.version,
  };
}

/**
 * `${VAR}` 展开。变量不存在就展开成空串 —— 必填字段（url / command）随后
 * 会因为空值被拒绝并指名缺哪个变量，比「原样把 ${TOKEN} 发出去」安全。
 */
function expandEnv(value: string, serverId: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`[mcp] ${serverId} 引用的环境变量 ${name} 没有设置，展开成空串`);
      return '';
    }
    return resolved;
  });
}

function expandEnvRecord(record: Record<string, string>, serverId: string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandEnv(value, serverId)]));
}
