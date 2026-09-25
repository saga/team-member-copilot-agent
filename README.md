# team-member-copilot-agent

A server-side AI Team platform built on GitHub Copilot SDK.

```
User
│
├── Direct Conversation ────────────────┐
│                                       │
└── Group Conversation                  │
                                        │
        ├── Researcher Member ── Runtime ── Copilot Session
        ├── Coder Member ─────── Runtime ── Copilot Session
        └── Reviewer Member ──── Runtime ── Copilot Session
                                        │
        ├── Skills
        ├── Memory
        ├── Workspace
        └── ask_member
```

## Core model

| 概念 | 含义 |
|------|------|
| **Member** | 业务上的长期 AI 同事。持久身份 + role + style + system prompt + model + skills + long-term memory。跨 conversation 稳定。 |
| **Conversation** | 聊天/协作空间。`direct`（一个 Member）/ `group`（多个 Member）/ `work`（独立工作会话）。 |
| **MemberRuntime** | 某 Member 在某 Conversation 中的运行实例。一个 runtime 拥有一个稳定的 Copilot Session 和一个独立 workspace。 |
| **CopilotSession** | Runtime 的执行引擎状态。**内部实现细节，不是业务对象。** |
| **Execution** | 一次实际工作。记录 `parent_execution_id` 和 `delegation_path`，构成完整审计链。 |

边界纪律：

```
Member             = 业务上的长期 AI 同事
Conversation       = 聊天/协作空间
MemberRuntime      = 某 Member 在某 Conversation 中的运行实例
CopilotSession     = Runtime 的执行引擎状态
Execution          = 一次实际工作
```

**不要把 CopilotSession 当作 Member。**

## Architecture

```
User → Conversation → MemberRuntime → Copilot SDK → Copilot CLI
```

Member → Member 协作通过宿主拥有的 `ask_member` custom tool 暴露：

```
Copilot Session
  → ask_member (custom tool)
  → TeamService.delegateMember()
  → target Member Runtime
  → Copilot Session
  → result 原路返回
```

**不是** Agent A 直接 new Agent B。所以每次协作都会在服务端留下 `Execution.parent_execution_id` + `delegation_path`。

### 为什么不用 SDK `customAgents`

```
customAgents = Runtime 内部 sub-agent（一个 Session 内的编排）
Member       = 应用层业务身份（跨 Conversation 稳定）
```

把 Member 建成 `customAgents` 会把业务身份绑死在某个 Session 上。保持分离后，未来把引擎换成 DeepAgents / OpenCode / Claude Agent SDK，`Member` / `Conversation` / `Execution` / `Delegation` 都不用改。

### Runtime 隔离

服务端使用 Copilot SDK `mode: "empty"`，由应用显式控制：

- tools（`ToolSet` allow-list：`BuiltInTools.Isolated` + 自定义工具）
- workspace（`.data/workspaces/<conversation-id>/<member-id>/`）
- skills（`.data/members/<member-id>/skills/`）
- Member 身份（`systemMessage` append）
- delegation（`ask_member`）
- memory（`.data/members/<member-id>/memory/MEMORY.md`）

`toolProfile` 决定工具面：

| profile | 可用工具 |
|---------|----------|
| `safe`（默认） | SDK isolated built-ins + `ask_member` + `remember_member` |
| `coding` | `safe` 再加 `bash` / `edit` / `grep` / `web_fetch` |

> `coding` 没有 sandbox 时 `bash` 可以触达宿主机边界，不要直接用于多租户生产环境。

## 快速开始

```bash
npm install
cp .env.example .env   # 按需填 GITHUB_TOKEN（留空则用 copilot CLI 已登录用户）

npm run dev            # 同时启动 client(:5173) + server(:3001)
# 浏览器打开 http://localhost:5173
```

单独启动：`npm run dev:server` / `npm run dev:client`；类型检查：`npm run typecheck`；测试：`npm run test`。

生产：`npm run build && npm start`（Express serve `dist/` + `/api`，同源单端口）。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | `{ status, timestamp, copilot: connected\|idle\|error }` |
| GET | `/api/health/ready` | 就绪探针 |
| GET | `/api/members` | Member 列表 |
| POST | `/api/members` | 创建 Member |
| GET | `/api/members/:id` | 单个 Member |
| PATCH | `/api/members/:id` | 更新 Member（含 archive） |
| GET | `/api/conversations` | Conversation 列表（含 members） |
| POST | `/api/conversations` | 创建 Direct / Group / Work |
| GET | `/api/conversations/:id` | 单个 Conversation |
| GET | `/api/conversations/:id/messages?limit=` | 最近 N 条消息（时间正序） |
| POST | `/api/conversations/:id/messages` | 发送消息 → `202 { message, executionId }` |
| POST | `/api/conversations/:id/members` | 加入 Member |
| DELETE | `/api/conversations/:id/members/:memberId` | 移出 Member |
| GET | `/api/conversations/:id/events` | 会话级 SSE |

`POST /messages` 只负责落库 + 入队并返回 202；所有实时事件从会话级 SSE 出去：

```
POST message
  ↓
202 { message, executionId }
  ↓
Conversation SSE
  ├── message.created
  ├── message.delta
  ├── execution.updated
  ├── delegation.started
  ├── message.created   (被委派的 Member)
  └── delegation.finished
```

### 典型用法

创建一个 Researcher：

```http
POST /api/members
Content-Type: application/json
```

```json
{
  "name": "Researcher",
  "handle": "researcher",
  "role": "Research Analyst",
  "description": "负责研究资料分析、事实核查和研究总结",
  "style": "严谨、简洁、引用证据",
  "systemPrompt": "优先区分事实、推论和不确定性。",
  "model": "gpt-5",
  "toolProfile": "safe"
}
```

Direct Chat：

```json
{ "kind": "direct", "memberIds": ["researcher-id"] }
```

Group Chat：

```json
{
  "kind": "group",
  "title": "Investment Review Team",
  "memberIds": ["researcher-id", "coder-id", "reviewer-id"],
  "defaultMemberId": "researcher-id"
}
```

发消息时用 `targetMemberId` 决定谁回应（第一版不做 LLM router，保持确定性）：

```json
{ "content": "请 @coder 根据这个结论写一个验证脚本", "targetMemberId": "coder-id" }
```

## Storage

不需要 PostgreSQL，也不需要 ORM。Node >= 22.13 直接用内置 `node:sqlite`。

```
.data/
├── team-member.db                     # member / conversation / conversation_member /
│                                      # conversation_message / member_runtime / execution
├── members/
│   └── <member-id>/
│       ├── SOUL.md                    # role / description / style / system prompt
│       ├── memory/MEMORY.md           # 长期记忆（remember_member 写入）
│       └── skills/                    # skillDirectories
├── workspaces/
│   └── <conversation-id>/
│       └── <member-id>/AGENTS.md      # 每个 runtime 独立 workspace
└── copilot/                           # Copilot session state
```

`delegation_path` 用来防：

```
A → B → C → A            （cycle）
A → B → C → D → ...      （无限深链，受 MAX_DELEGATION_DEPTH 限制）
```

## 目录结构

```
src/                          # Vite + React 前端
  App.tsx
  index.css
  components/
    HealthBadge.tsx
    TeamChat.tsx
  lib/api.ts                  # 后端 API 客户端（含 SSE 解析）

server/                       # Express + Copilot SDK 后端
  config.ts                   # 环境变量
  db.ts                       # node:sqlite + schema
  domain.ts                   # Member / Conversation / Runtime / Execution 类型
  copilot.ts                  # MemberRuntime → CopilotSession 执行引擎 + custom tools
  member-service.ts           # 长期 Member 身份 + member home
  team-service.ts             # 核心编排：Conversation / Execution / Delegation / SSE
  app.ts                      # 依赖装配
  index.ts                    # listen + 优雅退出
  middleware/errorHandler.ts
  routes/
    health.ts
    members.ts
    conversations.ts
  test/
    schemas.test.ts
    team-service.test.ts      # delegation cycle / depth / runtime 隔离
```

## 前提

- Node.js >= 22.13（`engines` 要求；`node:sqlite` 会打印一条 experimental 警告，属正常）
- Copilot 认证二选一：本机 `copilot` CLI 已登录，或 `.env` 里填 `GITHUB_TOKEN`
- `@github/copilot-sdk` pin 在 `1.0.14`；升级时需同步验证 runtime 行为

## 后续扩展点

- 认证：`local-user` 是占位。接 Entra ID / AD / OIDC 时只改请求上下文，业务数据模型不动。
- 会话记忆 vs Member 记忆：`conversation_message` 是会话上下文，`members/<id>/memory/MEMORY.md` 是 Member 长期记忆，两者不要混。
- 只在真正出现「谁该接这个问题」的规模后，再引入 Member Router（LLM 路由会多一层概率性决策）。
- `coding` profile 上生产前必须补 sandbox。
