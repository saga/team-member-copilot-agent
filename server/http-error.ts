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
