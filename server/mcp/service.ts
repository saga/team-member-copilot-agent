import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { now } from '../db.js';
import { badRequest, conflict, notFound } from '../http-error.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { loadMcpServerDefinitions } from './registry.js';
import type { McpAuthType, McpServerDefinition, McpServerType } from './types.js';

export type { McpAuthType };

/**
 * MCP Server 定义的运行时 source of truth（`mcp_server` 表）。
 *
 * `config/mcp-servers.json` 只是新库的 provisioning baseline：空库启动时读
 * 一次，之后增删改只走这里，文件改了不会回头覆盖 —— 和 capability templates
 * 同一套「只读一次」纪律（删光 server 后重启不会复活，因为 seed 只看建库那一刻）。
 *
 * 每次变更都同步 CapabilityRegistry：resolver / catalog 读的永远是同一份。
 */

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
  /**
   * 有没有配凭证引用。
   *
   * 它回答的是「指向了一个密钥库条目」，不是「那个条目存在」—— 后者要等一次
   * 真正的解析才知道。这个区别是刻意的：管理界面不该为了显示一个绿点去读密钥库。
   */
  secretConfigured: boolean;
  /**
   * 密钥库里的引用名（例如 `prod/jira/copilot`）。
   *
   * 它不是秘密 —— 它只是「去哪找」的指针，所以可以回显；而**值**永远拿不到。
   * 回显它是必要的：否则管理员改完配置后无法确认自己指的是哪一条。
   */
  secretRef: string | null;
  /** 环境变量名清单（值不返回）：编辑器据此显示“已配 3 个”，改动走合并。 */
  envKeys: string[];
  tools: Array<{ name: string; description: string; risk: string }>;
  enabled: boolean;
  status: 'unknown' | 'connected' | 'error';
  updatedAt: string;
}

/** 认证头名。出现在 `headers` 输入里就说明有人想把凭证写进 DB —— 直接拒。 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization']);

/**
 * API 输入形状（create / update 共用）。
 *
 * ── 没有 `secret` 这个字段 ───────────────────────────────────────────
 *
 * 旧版本有一个 `secret: string`，写进 `headers_json`。它被**移除**而不是
 * 被改名：留着一个能存凭证的入口，就等于「DB 不存凭证」这条纪律只靠自觉。
 * 现在唯一的凭证入口是 `secretRef`（一个名字），值在运行时从密钥库取。
 *
 * `headers` 仍然可以填，但认证头被显式拒绝 —— 它们是凭证的另一种写法。
 * 这条校验是这次改动里唯一真正起作用的地方：`headers` 是自由字典，不拦它，
 * 想写 token 的人只是换了个字段名。
 */
export const mcpServerApiInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'MCP server id 只能是字母数字及 - _，且以字母数字开头'),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(['local', 'http', 'sse']),
  url: z.string().max(2000).optional(),
  authType: z.enum(['none', 'bearer', 'apiKey']).optional(),
  headers: z
    .record(z.string(), z.string().max(2000))
    .optional()
    .refine(
      (headers) => !headers || !Object.keys(headers).some((key) => CREDENTIAL_HEADERS.has(key.toLowerCase())),
      {
        message:
          '认证头不能写在 headers 里（那等于把凭证存进数据库）：请用 secretRef 指向密钥库条目，值在运行时解析',
      },
    ),
  secretRef: z
    .string()
    .trim()
    .max(500)
    .refine((ref) => ref === '' || /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref), 'secretRef 只能是字母数字及 . _ / -')
    .optional(),
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
  secret_ref: string | null;
  auth_type: McpAuthType | null;
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
      parsed.data.headers ?? {},
      parsed.data.env ?? {},
      this.allowLocal,
    );
    this.insertRow(definition, parsed.data.enabled);
    this.registry.registerMcpServer(definition);
    return toView(this.requireRow(definition.id));
  }

  /**
   * 全量替换（PUT 语义），只有三样东西是合并语义：
   * `headers`（自定义非敏感头）、`env`、`secretRef`。
   *
   * 为什么 `secretRef` 没传 = 保持现状：它是「去哪找凭证」的指针，而客户端
   * 拿到的视图里已经有它了 —— 但要求每次编辑都原样回填一个指向生产密钥库的
   * 名字，会让「只想改个工具名」变成一次凭证重新指向的风险。没传就保持。
   *
   * 传空串 = 显式清掉引用（这是唯一能取消凭证的方式，所以必须能表达）。
   */
  update(id: string, input: unknown): McpServerView {
    const current = this.requireRow(id);
    const parsed = mcpServerApiInputSchema.safeParse({ ...(input as Record<string, unknown>), id });
    if (!parsed.success) {
      throw badRequest(`MCP Server 不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`);
    }
    const previousHeaders = parseJson<Record<string, string>>(current.headers_json, 'headers');
    const previousEnv = parseJson<Record<string, string>>(current.env_json, 'env');
    const nextHeaders =
      parsed.data.headers === undefined ? previousHeaders : { ...previousHeaders, ...parsed.data.headers };
    const nextEnv = parsed.data.env === undefined ? previousEnv : { ...previousEnv, ...parsed.data.env };
    const nextSecretRef =
      parsed.data.secretRef === undefined ? current.secret_ref : parsed.data.secretRef === '' ? null : parsed.data.secretRef;
    const nextAuthType = parsed.data.authType === undefined ? current.auth_type : parsed.data.authType;
    const definition = toDefinition(parsed.data, nextHeaders, nextEnv, this.allowLocal, nextSecretRef, nextAuthType);
    this.db
      .prepare(
        `UPDATE mcp_server SET display_name = ?, description = ?, type = ?, url = ?,
          headers_json = ?, command = ?, args_json = ?, env_json = ?, cwd = ?, timeout = ?,
          tools_json = ?, version = ?, enabled = ?, secret_ref = ?, auth_type = ?, updated_at = ? WHERE id = ?`,
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
        nextSecretRef,
        nextAuthType,
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
          env_json, cwd, timeout, tools_json, version, enabled, secret_ref, auth_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        server.secretRef ?? null,
        server.authType ?? null,
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
 * headers / env / secretRef 由调用方按合并规则算好传进来，
 * enabled 由调用方单独处理 —— 定义只说怎么连，不说开不开。
 */
function toDefinition(
  input: McpServerInput,
  headers: Record<string, string>,
  env: Record<string, string>,
  allowLocal: boolean,
  secretRef: string | null = input.secretRef === undefined || input.secretRef === '' ? null : input.secretRef,
  authType: McpAuthType | null = input.authType ?? null,
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
    ...(secretRef === null ? {} : { secretRef }),
    ...(authType === null ? {} : { authType }),
    tools,
    version: input.version,
  };
}

/**
 * 从**非敏感** header 里认出认证方式。
 *
 * 只在老数据上还有用：新写入的行的认证方式在 `auth_type` 列里。留着这个函数
 * 是因为升级上来的库里可能存在历史行 —— 它们的 headers 里确实还有明文凭证
 * （那时没有别的存法）。读接口据此仍然显示「配了认证」，而不是显示「没配」，
 * 于是管理员有机会看见它、把它换成 secretRef。
 */
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
    ...(row.secret_ref === null ? {} : { secretRef: row.secret_ref }),
    ...(row.auth_type === null ? {} : { authType: row.auth_type }),
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
  // 认证方式优先取列里的（新写入的行）；老行没有这一列，回落到从 header 里认。
  const authType = row.auth_type ?? detectAuthType(headers);
  // 「配了凭证」有两个来源：新写法（secret_ref）与老写法（headers 里还有明文）。
  // 两者都报 true —— 老行必须显示成「已配」，否则管理员看不到它、也就不会去换。
  const secretConfigured = row.secret_ref !== null || detectAuthType(headers) !== 'none';
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
    secretRef: row.secret_ref,
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
