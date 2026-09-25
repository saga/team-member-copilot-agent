# team-member-copilot-agent

Copilot SDK + Vite + TypeScript + Express 基础框架。

参考对象：

- 整体前后端结构参考 `ai-interview-questions`（Vite 前端 + Express 后端同源 `/api`，dev 用 proxy、生产由 Express serve `dist/`）。
- Copilot SDK 接入参考 `copilot-server-agent`（本框架是它的最小可用子集：懒加载 `CopilotClient` + 内存会话 + 单轮 `sendAndWait`）。

```
src/ (Vite + React + TS, :5173) ── /api/* ─▶ server/ (Express + TS, :3001) ─▶ Copilot CLI runtime
```

## 快速开始

```bash
npm install
cp .env.example .env   # 按需填 GITHUB_TOKEN（留空则用 copilot CLI 已登录用户）

npm run dev            # 同时启动 client(:5173) + server(:3001)
# 浏览器打开 http://localhost:5173
```

单独启动：`npm run dev:server` / `npm run dev:client`；类型检查：`npm run typecheck`；测试：`npm run test`。

生产：`npm run build && npm start`（Express serve `dist/` + `/api`，同源单端口）。

## API 契约（React → Express）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | `{ status, uptime, copilot: connected\|idle\|error }`（`idle` = 懒加载未建连，不是故障） |
| GET | `/api/health/ready` | 就绪探针 → `{ status: "ready" }` |
| POST | `/api/sessions` `{ model? }` | 创建会话 → `{ sessionId }` |
| GET | `/api/sessions` | 会话 id 列表（内存） |
| DELETE | `/api/sessions/:id` | 销毁会话 |
| POST | `/api/sessions/:id/chat` `{ prompt, streaming?, model? }` | 一轮 agent turn；`streaming:false` 返回 `{ content }`，`true` 返回 SSE（`delta/message/done/error`） |

前端示例见 `src/lib/api.ts`（`api.health/createSession/chat/chatStream`）和 `src/components/Chat.tsx`。

## 目录结构

```
src/                  # Vite + React 前端
  lib/api.ts          # 后端 API 客户端（含 SSE 流式解析）
  components/         # Chat / HealthBadge
server/               # Express + Copilot SDK 后端（TS，tsx 运行 / tsc 编译到 dist-server/）
  index.ts            # app 装配 + 静态托管 + 优雅退出
  config.ts           # 环境变量（非法值应在后续按需加 fail-fast 校验）
  copilot.ts          # CopilotClient 懒加载单例 + 内存会话 + 串行 turn（替换存储只改这里）
  routes/             # health / sessions（含 SSE chat）
  test/               # node:test 请求体校验
```

## 扩展点（往生产演进时参考 copilot-server-agent）

- 持久化会话 / execution 审计 / 多副本：给 `server/copilot.ts` 换存储实现。
- 工具授权（workspace 隔离、bash 策略）、HITL 审批、MCP、hooks：按路由逐个加。
- SDK 与 CLI 版本 pin：`@github/copilot-sdk` 升级时同步验证 runtime。

## 前提

- Node.js >= 22.13（`engines` 要求）
- Copilot 认证二选一：本机 `copilot` CLI 已登录，或 `.env` 里填 `GITHUB_TOKEN`
