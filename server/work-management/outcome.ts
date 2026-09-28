/**
 * 外部写入的**结果确定性** —— Command 状态机的判据。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 *
 * 「Command completed」不是「HTTP 返回 200」。两者之间隔着一整个失败谱系，
 * 而把它压成「成功 / 失败」两档会造成两种真实的伤害：
 *
 *   把「结果未知」记成成功  → 没人去查，一次可能没发生的写入被当成已发生
 *   把「结果未知」记成失败  → 人会去重试，于是**可能已经发生的那次**再来一遍
 *
 * 后者更常见也更要命：timeout、connection reset、5xx 都属于「请求发出去了，
 * 但没能确认对方有没有处理」。它们必须进入 `unknown`，由对账（reconcile）收敛。
 *
 * ── 判据的来源优先级 ─────────────────────────────────────────────────
 *
 *   1. 明确的 `ExternalOperationError`（传输层自己知道发生了什么）
 *   2. HTTP 状态码（有响应 = 服务端表态了）
 *   3. 系统错误码 / 错误类型（AbortError / ECONNRESET / …）
 *   4. 都认不出来 → **unknown**
 *
 * 第 4 条刻意选 unknown：这个函数回答的问题是「它**可能**已经发生了吗」。
 * 认不出来的错误无法证明「没有发生」，而在这个方向上猜错的代价是不可撤销的
 * 重复副作用。想让它变成 definite 的一方（本地校验错误之类）应当显式抛
 * `ExternalOperationError(msg, 'definite')`。
 */

/** 一次外部调用的结果确定性。 */
export type ExternalFailureKind = 'definite' | 'unknown';

/**
 * 传输层翻译出来的外部调用错误。
 *
 * ── 为什么不用字符串匹配 ──────────────────────────────────────────────
 *
 * 「Jira API 500 POST …」这种文案会随实现漂移（改个措辞、换个 Provider、
 * 加一层代理），而它的消费者是一个**状态机**：判错的后果是一次重复的外部
 * 副作用。所以把「发生了什么」做成结构化字段，文案只给人看。
 */
export class ExternalOperationError extends Error {
  constructor(
    message: string,
    readonly kind: ExternalFailureKind,
    /**
     * HTTP 状态码。null = 连响应都没有（网络层失败 / 超时 / 请求根本没发出去）。
     */
    readonly status: number | null = null,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExternalOperationError';
  }
}

/**
 * 对账的结论。`unknown` 是**合法结论**：对账也可能问不出来。
 *
 * 刻意不允许「对账推断出成功」——`completed` 只能来自「在外部系统里找到了
 * 这一笔的痕迹」（见 Jira 的 operation 标记）。猜出来的成功比未知更糟。
 */
export interface ExternalOperationOutcome {
  status: 'completed' | 'failed' | 'unknown';
  /** 给人和审计看的说明：找到了什么、没找到什么、为什么还是不知道。 */
  detail?: string | null;
}

/**
 * 网络层错误码 → 结果确定性。
 *
 * 分两类的依据是「请求有没有可能已经离开本机」：
 *
 *   CONNECTION_REFUSED / DNS 失败   连接没建起来 → 请求体没发出去 → definite
 *   RESET / TIMEOUT / SOCKET       连接建起来过，或者建到一半断了 → unknown
 *
 * `UND_ERR_*` 是 undici（Node 内置 fetch）的码，它们不带 HTTP 状态码，
 * 所以只能在这里认。
 */
const NETWORK_DEFINITE_CODES = new Set([
  // TCP 连接被拒：没有连接，就没有请求。
  'ECONNREFUSED',
  // 名字解析不出来：请求还没离开本机。
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  // 地址不可达 / 网络不可达：同上。
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
]);

const NETWORK_UNKNOWN_CODES = new Set([
  // 连接建立之后被重置 —— 服务端**可能**已经处理了。
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  // undici 的传输层码：全都是「连接有问题」，而连接有问题的另一半是
  // 「服务端可能已经收到并处理了」。
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_HEADERS_OVERFLOW',
]);

/** `AbortSignal.timeout()` / `AbortController.abort()` 抛出来的错误名。 */
const TIMEOUT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/**
 * HTTP 状态码 → 结果确定性。
 *
 *   5xx                 服务端**收到了**请求但没给出结论 → unknown
 *   408 Request Timeout 服务端收到了但没处理完 → unknown
 *   425 Too Early       同上
 *   429 Too Many Requests  请求被拒了，但可能在限流之前已经处理过一部分 → unknown
 *   其它 4xx（含 412）  服务端明确拒绝 → definite
 *
 * 412 单独值得说一句：它是 `If-Unmodified-Since` 不匹配，也就是**服务端在
 * 事务里比过版本之后拒绝了这次写入**。它看起来像失败，但它是一条强证据：
 * 写入没有发生。把它归到 unknown 会让每次并发冲突都要人去对账一遍。
 *
 * 导出给**传输层**用：HTTP 客户端比谁都清楚自己拿到了什么状态码，它应当直接
 * 构造 `ExternalOperationError`（带上真实 status），而不是抛一个裸 Error 让
 * 上层去猜 —— 猜的那一层看不到 status，只能落到默认的 unknown。
 */
export function kindForStatus(status: number): ExternalFailureKind {
  if (status >= 500) return 'unknown';
  if (status === 408 || status === 425 || status === 429) return 'unknown';
  return 'definite';
}

/** 从各种错误形状里挖出 HTTP 状态码。挖不到返回 null。 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Record<string, unknown>;
  for (const key of ['status', 'statusCode']) {
    const value = candidate[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const response = candidate.response;
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  return null;
}

/** 从各种错误形状里挖出系统错误码。 */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>).code;
  return typeof value === 'string' && value ? value : null;
}

/**
 * 这一次外部调用到底「确定没发生」还是「可能已经发生」。
 *
 * 判定顺序见文件头。`cause` 会被递归看一层以上 —— `fetch` 把真正的系统错误
 * 包在 `TypeError: fetch failed` 的 `cause` 里，只看最外层什么都认不出来。
 */
export function classifyExternalError(error: unknown): ExternalFailureKind {
  return classify(error, 0);
}

function classify(error: unknown, depth: number): ExternalFailureKind {
  if (error instanceof ExternalOperationError) return error.kind;

  const status = statusOf(error);
  if (status !== null) return kindForStatus(status);

  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && TIMEOUT_ERROR_NAMES.has(name)) return 'unknown';
  }

  const code = codeOf(error);
  if (code) {
    if (NETWORK_UNKNOWN_CODES.has(code)) return 'unknown';
    if (NETWORK_DEFINITE_CODES.has(code)) return 'definite';
  }

  // 递归深度刻意小：`cause` 链偶尔会成环（手写的错误包装），而这里不需要
  // 「找到最底层的原因」—— 前两层覆盖了 fetch / undici / 手写包装这三种形态。
  if (depth < 3 && typeof error === 'object' && error !== null) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error) return classify(cause, depth + 1);
  }

  // 认不出来 → unknown。理由见文件头：这个方向猜错的代价是不可撤销的。
  return 'unknown';
}
