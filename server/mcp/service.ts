import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { now } from '../db.js';
import { badRequest, conflict, notFound } from '../http-error.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { loadMcpServerDefinitions } from './registry.js';
import type { McpServerDefinition, McpServerType } from './types.js';

/**
 * MCP Server 定义的运行时 source of truth（`mcp_server` 表）。
 *
 * `config/mcp-servers.json` 只是新库的 provisioning baseline：空库启动时读
 * 一次，之后增删改只走这里，文件改了不会回头覆盖 —— 和 capability templates
 * 同一套「只读一次」纪律（删光 server 后重启不会复活，因为 seed 只看建库那一刻）。
 *
 * 每次变更都同步 CapabilityRegistry：resolver / catalog 读的永远是同一份。
 */

export type McpAuthType = 'none' | 'bearer' | 'apiKey';

/** 读接口的形状：连接串的值永远脱敏，只回答「配没配」。 */
export interface McpServerView {
  id: string;
  name: string;
  description: string;
  type: McpServerType;
  url: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  timeout: number | null;
  version: string;
  authType: McpAuthType;
  /** 有没有存着可用的 secret（值永远不返回）。 */
  secretConfigured: boolean;
  /** 环境变量名清单（值不返回）：编辑器据此显示“已配 3 个”，改动走合并。 */
  envKeys: string[];
  tools: Array<{ name: string; description: string; risk: string }>;
  enabled: boolean;
  status: 'unknown' | 'connected' | 'error';
  updatedAt: string;
}

/**
 * API 输入形状（create / update 共用）。和文件形状的区别：
 * secret 单独一个字段（读接口从不回显，客户端不可能原样回填 headers），
 * tools 是行数组（UI 按行编辑）。存进 DB / 定义时再翻译成存储形状。
 */
export const mcpServerApiInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'MCP server id 只能是字母数字及 - _，且以字母数字开头'),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(['local', 'http', 'sse']),
  url: z.string().max(2000).optional(),
  authType: z.enum(['none', 'bearer', 'apiKey']).optional(),
  secret: z.string().max(2000).optional(),
  command: z.string().min(1).max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().max(500).optional(),
  timeout: z.number().int().positive().max(3_600_000).optional(),
  tools: z
    .array(
      z.object({
        name: z
          .string()
          .refine((name) => name !== '*', { message: 'MCP 工具必须显式列出，不支持 "*"' })
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'MCP 工具名只能是字母数字及 - _，且以字母数字开头'),
        risk: z.enum(['read', 'self-write', 'coordination', 'external-read', 'external-write', 'host-execution', 'privileged']),
      }),
    )
    .min(1)
    .max(100)
    .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, {
      message: 'MCP 工具名重复',
    }),
  version: z.string().trim().min(1).max(100).default('1'),
  enabled: z.boolean().default(true),
});

type McpServerInput = z.infer<typeof mcpServerApiInputSchema>;

interface McpServerRow {
  id: string;
  display_name: string;
  description: string;
  type: McpServerType;
  url: string | null;
  headers_json: string;
  command: string | null;
  args_json: string;
  env_json: string;
  cwd: string | null;
  timeout: number | null;
  tools_json: string;
  version: string;
  enabled: number;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_error: string | null;
  created_at: string;
  updated_at: string;
}

const BEARER_HEADER = 'authorization';
const API_KEY_HEADER = 'x-api-key';

export class McpServerService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly registry: CapabilityRegistry,
    private readonly allowLocal: boolean,
  ) {}

  /**
   * 表空时从文件导入一次（防御性兜底）。真正的“只在新库读一次”由
   * seedMcpServersOnBoot 按 migration.created 决定 —— 只看“表空不空”会在
   * 管理员删光 server 后重启又复活它们。
   *
   * 只写 DB，不管 registry：注册由调用方在后面统一做（否则 seed 和全量同步
   * 两处注册，空库启动直接撞重）。
   */
  seedFromFileIfEmpty(filePath: string): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM mcp_server`).get() as unknown as { n: number };
    if (row.n > 0) return false;
    // 空表时直接全量导入：行数来自受控的定义文件，不需要分批。
    for (const server of loadMcpServerDefinitions(filePath, { allowLocal: this.allowLocal })) {
      this.insertRow(server, true);
    }
    return true;
  }

  /** 全部定义（含停用的，给启动时同步 registry 用）。secret 也在里面，只给内部用。 */
  listDefinitions(): McpServerDefinition[] {
    const rows = this.db.prepare(`SELECT * FROM mcp_server ORDER BY id`).all() as unknown as McpServerRow[];
    return rows.map(rowToDefinition);
  }

  list(): McpServerView[] {
    const rows = this.db.prepare(`SELECT * FROM mcp_server ORDER BY id`).all() as unknown as McpServerRow[];
    return rows.map(toView);
  }

  get(id: string): McpServerView {
    return toView(this.requireRow(id));
  }

  create(input: unknown): McpServerView {
    const parsed = mcpServerApiInputSchema.safeParse(input);
    if (!parsed.success) {
      throw badRequest(`MCP Server 不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`);
    }
    if (this.findRow(parsed.data.id)) {
      throw conflict(`MCP Server 已存在：${parsed.data.id}`);
    }
    const definition = toDefinition(
      parsed.data,
      resolveAuthHeaders(null, parsed.data, parsed.data.id),
      parsed.data.env ?? {},
      this.allowLocal,
    );
    this.insertRow(definition, parsed.data.enabled);
    this.registry.registerMcpServer(definition);
    return toView(this.requireRow(definition.id));
  }

  /**
   * 全量替换（PUT 语义），只有两样东西是合并语义：
   * secret（读接口从不回显，没传 = 保持现状）与 env（同理）。
   * 其余字段以请求为准 —— 包括 enabled 开关。
   */
  update(id: string, input: unknown): McpServerView {
    const current = this.requireRow(id);
    const parsed = mcpServerApiInputSchema.safeParse({ ...(input as Record<string, unknown>), id });
    if (!parsed.success) {
      throw badRequest(`MCP Server 不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`);
    }
    const previous = parseJson<Record<string, string>>(current.headers_json, 'headers');
    const previousEnv = parseJson<Record<string, string>>(current.env_json, 'env');
    const nextHeaders = resolveAuthHeaders(previous, parsed.data, id);
    const nextEnv = parsed.data.env === undefined ? previousEnv : { ...previousEnv, ...parsed.data.env };
    const definition = toDefinition(parsed.data, nextHeaders, nextEnv, this.allowLocal);
    this.db
      .prepare(
        `UPDATE mcp_server SET display_name = ?, description = ?, type = ?, url = ?,
          headers_json = ?, command = ?, args_json = ?, env_json = ?, cwd = ?, timeout = ?,
          tools_json = ?, version = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        definition.displayName,
        definition.description ?? '',
        definition.type,
        definition.url ?? null,
        JSON.stringify(nextHeaders),
        definition.command ?? null,
        JSON.stringify(definition.args ?? []),
        JSON.stringify(nextEnv),
        definition.cwd ?? null,
        definition.timeout ?? null,
        JSON.stringify(definition.tools),
        definition.version,
        parsed.data.enabled ? 1 : 0,
        now(),
        id,
      );
    this.registry.removeMcpServer(`mcp.${id}`);
    this.registry.registerMcpServer(definition);
    return toView(this.requireRow(id));
  }

  remove(id: string): void {
    this.requireRow(id);
    this.db.prepare(`DELETE FROM mcp_server WHERE id = ?`).run(id);
    // 引用它的 capability binding 留着：目录按原文展示、可关闭，
    // 和 knowledge 的 dangling key 同一处理，不静默删别人的配置。
    this.registry.removeMcpServer(`mcp.${id}`);
  }

  /**
   * 可达性检查，不是 MCP 握手：不断言协议、不发现工具。
   *
   * http/sse 只看「有没有 HTTP 响应」（4xx/5xx 也算可达，只说明地址与网络是对的）；
   * local 只看 command 能不能在 PATH 里找到，绝不真的执行它 —— Test 按钮不能
   * 变成一次任意命令执行。不带任何认证信息发请求。
   */
  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    const row = this.requireRow(id);
    let result: { ok: boolean; detail: string };
    if (row.type === 'local') {
      result = testLocalCommand(row.command ?? '');
    } else {
      result = await testHttpUrl(row.url ?? '');
    }
    this.db
      .prepare(`UPDATE mcp_server SET last_test_at = ?, last_test_ok = ?, last_test_error = ?, updated_at = ? WHERE id = ?`)
      .run(now(), result.ok ? 1 : 0, result.ok ? null : result.detail, now(), id);
    return result;
  }

  private insertRow(server: McpServerDefinition, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO mcp_server (
          id, display_name, description, type, url, headers_json, command, args_json,
          env_json, cwd, timeout, tools_json, version, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        server.id,
        server.displayName,
        server.description ?? '',
        server.type,
        server.url ?? null,
        JSON.stringify(server.headers ?? {}),
        server.command ?? null,
        JSON.stringify(server.args ?? []),
        JSON.stringify(server.env ?? {}),
        server.cwd ?? null,
        server.timeout ?? null,
        JSON.stringify(server.tools),
        server.version,
        enabled ? 1 : 0,
        now(),
        now(),
      );
  }

  private findRow(id: string): McpServerRow | null {
    const row = this.db.prepare(`SELECT * FROM mcp_server WHERE id = ?`).get(id) as unknown as McpServerRow | undefined;
    return row ?? null;
  }

  private requireRow(id: string): McpServerRow {
    const row = this.findRow(id);
    if (!row) throw notFound(`MCP Server 不存在：${id}`);
    return row;
  }
}

/**
 * 输入 → 定义：local 门禁在这里再判一次（文件加载判过，但 UI 创建走不到 loader）。
 * headers / env 由调用方按合并规则算好传进来（见 resolveAuthHeaders），
 * enabled 由调用方单独处理 —— 定义只说怎么连，不说开不开。
 */
function toDefinition(
  input: McpServerInput,
  headers: Record<string, string>,
  env: Record<string, string>,
  allowLocal: boolean,
): McpServerDefinition {
  if (input.type === 'local' && !allowLocal) {
    throw badRequest(
      `MCP Server ${input.id} 是 local 类型，会在服务机器上启动子进程：在服务端设置 MCP_LOCAL_ENABLED=true 后才能注册`,
    );
  }
  const tools: McpServerDefinition['tools'] = {};
  for (const tool of input.tools) {
    tools[tool.name] = { risk: tool.risk };
  }
  return {
    id: input.id,
    displayName: input.displayName,
    ...(input.description === undefined ? {} : { description: input.description }),
    type: input.type,
    ...(input.url === undefined ? {} : { url: input.url }),
    headers,
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.args === undefined ? {} : { args: input.args }),
    env,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    tools,
    version: input.version,
  };
}

/**
 * 认证 slot → headers。规则只有四条：
 *   没传 secret 也没选认证 = 不碰（读接口不回显，只能这样表达“保持现状”）
 *   传了 secret 但没选认证 = 400（不知道往哪个 header 写）
 *   选了 none = 清掉两个认证 header（其它自定义 header 保留，归文件管）
 *   选了 bearer/apiKey + 给了 secret = 写入；没给 secret 时同类型沿用旧值，
 *   换类型必须给新 secret（旧 secret 不能跨类型复用）。
 */
function resolveAuthHeaders(
  current: Record<string, string> | null,
  input: Pick<McpServerInput, 'authType' | 'secret'>,
  serverId: string,
): Record<string, string> {
  const secretProvided = input.secret !== undefined && input.secret !== '';
  if (secretProvided && (input.authType === undefined || input.authType === 'none')) {
    throw badRequest(`MCP Server ${serverId} 传了 secret 但没选认证方式：authType 必须是 bearer 或 apiKey`);
  }
  if (input.authType === undefined) {
    return { ...(current ?? {}) };
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    const lower = key.toLowerCase();
    if (lower !== BEARER_HEADER && lower !== API_KEY_HEADER) next[key] = value;
  }
  if (input.authType === 'none') return next;
  if (!secretProvided) {
    if (detectAuthType(current) === input.authType && current) {
      for (const [key, value] of Object.entries(current)) {
        const lower = key.toLowerCase();
        if ((input.authType === 'bearer' && lower === BEARER_HEADER) || (input.authType === 'apiKey' && lower === API_KEY_HEADER)) {
          next[key] = value;
        }
      }
      return next;
    }
    throw badRequest(`MCP Server ${serverId} 切换认证方式必须提供新的 secret`);
  }
  next[input.authType === 'bearer' ? 'Authorization' : 'X-Api-Key'] =
    input.authType === 'bearer' ? `Bearer ${input.secret}` : (input.secret as string);
  return next;
}

function detectAuthType(headers: Record<string, string> | null): McpAuthType | 'none' {
  if (!headers) return 'none';
  const lowered = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (lowered[BEARER_HEADER]) return 'bearer';
  if (lowered[API_KEY_HEADER]) return 'apiKey';
  return 'none';
}

function rowToDefinition(row: McpServerRow): McpServerDefinition {
  return {
    id: row.id,
    enabled: row.enabled === 1,
    displayName: row.display_name,
    ...(row.description ? { description: row.description } : {}),
    type: row.type,
    ...(row.url === null ? {} : { url: row.url }),
    headers: parseJson<Record<string, string>>(row.headers_json, 'headers'),
    ...(row.command === null ? {} : { command: row.command }),
    args: parseJson<string[]>(row.args_json, 'args'),
    env: parseJson<Record<string, string>>(row.env_json, 'env'),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.timeout === null ? {} : { timeout: row.timeout }),
    tools: parseJson<McpServerDefinition['tools']>(row.tools_json, 'tools'),
    version: row.version,
  };
}

/**
 * 启动时的 seed 决策：只有全新数据库才读文件。
 *
 * 不看“表空不空”：管理员删光 server 是明确意图（“我们不用 MCP”），
 * 重启后复活它们等于把删除变成功能开关关不掉。seedFromFileIfEmpty 里
 * 的表空检查只是防御性兜底，真正的门在这里。
 */
export function seedMcpServersOnBoot(input: {
  freshInstall: boolean;
  service: McpServerService;
  filePath: string;
}): boolean {
  if (!input.freshInstall) return false;
  return input.service.seedFromFileIfEmpty(input.filePath);
}

function toView(row: McpServerRow): McpServerView {
  const headers = parseJson<Record<string, string>>(row.headers_json, 'headers');
  const authType = detectAuthType(headers);
  const secretConfigured = authType !== 'none';
  const tools = parseJson<Record<string, { risk: string }>>(row.tools_json, 'tools');
  return {
    id: row.id,
    name: row.display_name,
    description: row.description,
    type: row.type,
    url: row.url,
    command: row.command,
    args: parseJson<string[]>(row.args_json, 'args'),
    cwd: row.cwd,
    timeout: row.timeout,
    version: row.version,
    authType,
    secretConfigured,
    envKeys: Object.keys(parseJson<Record<string, string>>(row.env_json, 'env')).sort(),
    tools: Object.keys(tools)
      .sort()
      .map((name) => ({ name, description: '', risk: tools[name].risk })),
    enabled: row.enabled === 1,
    status: row.last_test_at === null ? 'unknown' : row.last_test_ok === 1 ? 'connected' : 'error',
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`mcp_server 行数据损坏（${field} 不是合法 JSON）`);
  }
}

function testLocalCommand(command: string): { ok: boolean; detail: string } {
  const binary = command.trim().split(/\s+/)[0] ?? '';
  if (!binary) return { ok: false, detail: 'command 为空' };
  const candidates = binary.includes('/')
    ? [binary]
    : (process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => `${dir}/${binary}`);
  for (const target of candidates) {
    try {
      fs.accessSync(target, fs.constants.X_OK);
      return { ok: true, detail: `找到可执行文件：${target}（只确认存在，没有执行它）` };
    } catch {
      // 继续找下一个
    }
  }
  return { ok: false, detail: binary.includes('/') ? `找不到可执行文件：${binary}` : `PATH 里找不到：${binary}` };
}

async function testHttpUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, detail: `url 不合法：${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, detail: `只支持 http(s)：${parsed.protocol}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'manual' });
    return { ok: true, detail: `HTTP ${response.status}（地址可达；这不是 MCP 握手，只说明网络与地址是对的）` };
  } catch (error) {
    return { ok: false, detail: `连接失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
