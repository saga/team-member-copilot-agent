/**
 * MCP 凭证的外部解析口。
 *
 * ── 为什么 DB 里不存凭证 ──────────────────────────────────────────────
 *
 * 旧做法是「把 token 存进 `mcp_server.headers_json`，读接口脱敏」。脱敏只挡住
 * API 这一条路，而凭证泄露的路径不止一条：
 *
 *   备份 / WAL 副本        sqlite3 file.db .dump 直接就能看到明文
 *   崩溃转储               进程内存里的行数据
 *   运维直连               能读文件的人不需要经过任何 API
 *   误提交                 .data/ 被谁 `git add -A` 一次
 *
 * 换成引用之后，DB 被完整拿走也只换到一个名字。**凭证留在密钥库里**，
 * 而密钥库有自己的访问控制、轮换与审计 —— 那是它该负责的事，不是这张表的。
 *
 * ── 返回形状为什么是「一组 header」 ───────────────────────────────────
 *
 * 而不是「一个 token 字符串」：不同系统的认证形态不一样（`Authorization:
 * Bearer x` / `X-Api-Key: x` / 自定义头），把「怎么拼 header」交给密钥库一侧，
 * 这里就只是**合并**，不需要认识任何一种认证方式。MCP Server 定义里的
 * `authType` 因此只是给界面看的提示，不参与运行时拼装。
 */
export interface SecretProvider {
  get(ref: string): Promise<Record<string, string>>;
}

/**
 * 从环境变量读。
 *
 * 值的格式是 JSON 对象（就是一组 header）：
 *
 *   MCP_SECRET_GH='{"Authorization":"Bearer ghp_xxx"}'
 *
 * 刻意不做「纯字符串 = token」的简写：那样就得知道往哪个 header 写，
 * 于是解析器又得认识认证方式 —— 正是上面那段注释要避免的事。而一个
 * 只在本地方便、在生产会静默拼错 header 的简写，代价比收益大。
 *
 * 生产替换为 AWS Secrets Manager / Azure Key Vault / K8s External Secrets
 * 时，只需要换一个实现了这个接口的类，`mcp_server.secret_ref` 里的值不用动。
 */
export class EnvSecretProvider implements SecretProvider {
  async get(ref: string): Promise<Record<string, string>> {
    const raw = process.env[ref];

    if (!raw) {
      throw new Error(
        `Secret ${ref} 未配置：MCP Server 的 secret_ref 指向了它，` +
          `请在运行环境里提供 ${ref}（值是一组 header 的 JSON，例如 {"Authorization":"Bearer xxx"}）`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Secret ${ref} 不是合法 JSON：期望一组 header，例如 {"Authorization":"Bearer xxx"}`,
      );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Secret ${ref} 必须是 JSON 对象（一组 header），当前是 ${Array.isArray(parsed) ? '数组' : typeof parsed}`);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`Secret ${ref} 的 ${key} 必须是字符串（header 值）`);
      }
      headers[key] = value;
    }
    return headers;
  }
}
