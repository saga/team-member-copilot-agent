/**
 * 业务错误 → HTTP 状态码。
 *
 * 这里只负责**打标记**：`sendError`（middleware/errorHandler）读 `status` 决定响应码。
 * 放成独立模块而不是塞在 TeamService 里，因为 TeamService 和 MemberConversationService
 * 是同级服务，都需要抛同一套语义的错误 —— 复制一份「3 行 helper」迟早会走样。
 */

/** 业务校验失败统一带 400。 */
export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/** 资源不存在统一带 404。 */
export function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 });
}

/** 请求合法但与当前状态冲突（比如 cancel 一条已经结束的 execution）。 */
export function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

/** 身份已知但没有权限（比如访问不属于该 Member 的 Knowledge Base）。 */
export function forbidden(message: string): Error {
  return Object.assign(new Error(message), { status: 403 });
}

/**
 * 上游系统没能给出结论（外部动作的结果未知）。
 *
 * ── 为什么不落回 500 ─────────────────────────────────────────────────
 *
 * 500 的语义是「我们这边坏了」，而这条路径的实际情况是**我们没坏，上游没答复**
 * —— 一次 Jira 超时被记成 500，会让 on-call 去翻自己的日志找一段不存在的异常。
 *
 * 502 也顺带把「不要重试」说清楚：调用方看到 5xx 通常会重试，而这里重试恰好是
 * 最危险的动作（那笔写入可能已经生效）。响应体里的说明是给人和模型看的，
 * 状态码只是让**运维**一眼分清该看谁的日志。
 *
 * 导出常量是因为「结果未知」这个语义不只用在 `Object.assign` 造出来的错误上 ——
 * `UnknownCommandOutcomeError` 是个 class，它需要同一个数字，而不是自己再写一遍
 * 502（两处写同一个码，迟早只改一处）。
 */
export const BAD_GATEWAY_STATUS = 502;

export function badGateway(message: string): Error {
  return Object.assign(new Error(message), { status: BAD_GATEWAY_STATUS });
}
