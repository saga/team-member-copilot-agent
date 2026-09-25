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
| **Execution** | 一次实际工作。记录 `parent_execution_id` 和 `delegation_path`，构成完整审计链。状态：`queued` / `running` / `waiting_for_member` / `completed` / `failed` / `cancelled` / `interrupted`。 |

两个游标保证顺序与可靠性：

```
conversation.event_sequence    —— SSE 的 Last-Event-ID
conversation.message_sequence  —— MemberRuntime.last_context_message_sequence 的 checkpoint
```

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

## Runtime reliability

「能跑的 Team Agent Demo」和「可靠的 Team Runtime」之间差的是下面五件事。当前实现把它们都收在 `server/` 里，没有引入 K8s sandbox、LLM router、policy service 或 scheduler。

| 问题 | 做法 |
|------|------|
| 没有持久队列，进程一挂就丢 | `execution` 表本身就是队列：`queued` / `running` / `waiting_for_member` / `interrupted`。启动时 `RecoveryService` 做一次保守恢复 |
| SSE 是易失的，断线就丢事件 | 事件先落 `conversation_event` 再广播；SSE 帧带 `id: <sequence>`，浏览器重连时用 `Last-Event-ID` 补发 |
| runtime 锁只在进程内 | per-runtime 串行锁 + `member_runtime.active_execution_id` 持久化视图，重启后能看出「谁在跑」 |
| 会话上下文和 Copilot session history 重复 | `ContextAssembler` 只注入 `message_sequence > last_context_message_sequence` 的新消息 |
| 并发 delegation 会死锁 | `delegation_path` 防同树环 + wait-for 图防跨树互相等待 |

### 1. 崩溃恢复：宁可漏跑，不可重跑

启动顺序是「迁移 → 恢复 → 重新提交 → listen」。

```
queued（root）        → 重新提交（它从来没开始跑过）
queued（child）       → interrupted（父 execution 已经没了，单独重跑没意义）
running               → interrupted
waiting_for_member    → interrupted
completed/failed/
cancelled/interrupted → 不动
```

**不自动重跑 `running`。** Copilot session 可能已经在崩溃前执行完工具，只是 `execution.completed` 没来得及落库；自动重跑会造成重复执行（发邮件、写文件、扣款）。要重做必须显式 `retryExecution()`，它会生成一条**新的** execution 并用 `retry_of_execution_id` 指回原记录，审计链不断。

> 当前实现假设**单进程独占 DB**。多副本部署前必须把「谁是 owner」升级成 DB 层 lease，否则第二个进程的恢复会误伤第一个进程正在跑的 execution。

### 2. 增量上下文：checkpoint 而不是整段重放

```
Copilot Session      = 该 Member runtime 自己的对话历史（引擎侧）
conversation_message = Team 共享历史
```

每轮只把「自该 runtime 上次**成功** turn 之后新增的 shared messages」拼进 prompt，`MemberRuntime.last_context_message_sequence` 就是 checkpoint。两类消息会被排除，因为它们已经在 session history 里：

1. 触发本次 execution 的那条消息（内容就是 `currentPrompt`）
2. 当前 runtime 自己产出的历史消息（即 session 里的 assistant turn）

水位线覆盖**读到的全部消息**（包括被过滤的那些），否则下一轮还会重复读到它们。checkpoint **只在 turn 成功后推进** —— 失败时保持不变，宁可重复也不要丢上下文。

### 3. Durable event + SSE replay

```
emit(event)
  ↓
message.delta ?  ── yes ──→ 只广播（token 级高频，不落库）
  │ no
  ↓
conversation_event (id, sequence)   ← DB 是 source of truth
  ↓
fan-out 给内存里的 SSE consumer     ← SSE 只是投递手段
```

- durable 事件带 `id: <sequence>`，浏览器自动维护 `Last-Event-ID`，重连时服务端补发断线期间的事件。
- `message.delta` 是**唯一**不落库的事件：它没有 `id` 帧，浏览器不会推进水位，丢了也不用补 —— 由 durable 的 `message.created`（携带完整内容）收敛。
- `TeamService.replayAndSubscribe()` 用「先挂监听并缓冲 → 回放 DB → 补发缓冲」保证回放与实时之间不留缝，重复投递由 sequence 去重。
- 也可以手动指定水位：`GET /api/conversations/:id/events?since=<sequence>`（`Last-Event-ID` 头优先）。

### 4. Delegation 死锁保护

两道独立的保护，防的是两种不同的环：

```
delegation_path 环   —— 同一个 delegation 树里不能 A → B → C → A
                        也限制最大深度（MAX_DELEGATION_DEPTH）

wait-for 环          —— A 的 runtime 等 B 的 runtime，B 的 runtime 又等 A 的
                        这是跨树的死锁，delegation_path 看不到
```

wait-for 图从 `execution.waiting_for_runtime_id` 推导（只认 `waiting_for_member` 状态的 execution）。检测 + 建 child + 标记父为 `waiting_for_member` 这三步之间**不能有 `await`**，否则两个方向的委托可能同时通过检测、双双进入等待。`node:sqlite` 是同步 API，所以整段天然是一个不可分割的同步块。

父 execution 在委派期间进入 `waiting_for_member`，并在 `finally` 里还原成它**本来的**状态（真实流程里是 `running`，因为 `ask_member` 是在父 turn 内被调用的）。

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
| GET | `/api/conversations/:id/messages?limit=` | 最近 N 条消息（按 `messageSequence` 正序） |
| POST | `/api/conversations/:id/messages` | 发送消息 → `202 { message, executionId }` |
| POST | `/api/conversations/:id/members` | 加入 Member |
| DELETE | `/api/conversations/:id/members/:memberId` | 移出 Member |
| GET | `/api/conversations/:id/events?since=` | 会话级 SSE（支持 `Last-Event-ID` 回放） |

`POST /messages` 只负责落库 + 入队并返回 202；所有实时事件从会话级 SSE 出去：

```
POST message
  ↓
202 { message, executionId }
  ↓
Conversation SSE
  ├── id: 1  message.created
  ├──         message.delta          (无 id，不落库，可丢)
  ├── id: 2  execution.updated
  ├── id: 3  delegation.started
  ├── id: 4  message.created   (被委派的 Member)
  └── id: 5  delegation.finished
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
│                                      # conversation_message / member_runtime / execution /
│                                      # conversation_event
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

### Schema 版本管理

用 `PRAGMA user_version`，不引入 migration framework（`server/db-migrations.ts`）。

| version | 内容 |
|---------|------|
| 1 | 初版六张表（旧代码用 `CREATE TABLE IF NOT EXISTS` 建出来的，没写 `user_version`） |
| 2 | `conversation.event_sequence` / `message_sequence`、`conversation_message.message_sequence`、`member_runtime.active_execution_id` / `last_context_message_sequence`、`execution.waiting_for_runtime_id` / `retry_of_execution_id`、`execution.status` 增加 `waiting_for_member` / `interrupted`、`conversation_event` |

约定：

- `user_version = 0` 且已存在 `member` 表 → 当作 v1（老库），不重建。
- `user_version = 0` 且库是空的 → 直接建 v2。
- `user_version > SCHEMA_VERSION` → 拒绝启动，避免新数据被老代码写坏。
- `execution` 要改 `status` 的 CHECK 约束，而 SQLite 不支持 `ALTER CHECK`，所以按官方 12 步流程重建表；重建期间 `PRAGMA foreign_keys = OFF` 必须放在 `BEGIN` **之前**（该 PRAGMA 在事务内无效），提交前跑 `PRAGMA foreign_key_check`。
- 升级时会同步计数器与水位线：`conversation.message_sequence` 追上历史最大值（否则下一条消息撞 UNIQUE），`member_runtime.last_context_message_sequence` 推到当前最大序号（否则升级后立刻重复注入一次全量上下文）。

### 两道环检测

```
delegation_path 防：
  A → B → C → A            （同树 cycle）
  A → B → C → D → ...      （无限深链，受 MAX_DELEGATION_DEPTH 限制）

waiting_for_runtime_id 防：
  runtime A 等 runtime B，runtime B 又等 runtime A   （跨树死锁）
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
  db.ts                       # node:sqlite 打开 + 迁移
  db-migrations.ts            # PRAGMA user_version 迁移（v1 → v2）
  domain.ts                   # Member / Conversation / Runtime / Execution 类型
  copilot.ts                  # MemberRuntime → CopilotSession 执行引擎 + custom tools
  context-assembler.ts        # 增量上下文（message_sequence checkpoint）
  recovery-service.ts         # 启动恢复（保守策略，不自动重跑 running）
  member-service.ts           # 长期 Member 身份 + member home
  team-service.ts             # 核心编排：Conversation / Execution / Delegation / 单写者 / durable event
  app.ts                      # 依赖装配
  index.ts                    # 迁移 → 恢复 → listen + 优雅退出
  middleware/errorHandler.ts
  routes/
    health.ts
    members.ts
    conversations.ts
  test/
    schemas.test.ts
    team-service.test.ts           # delegation cycle / depth / runtime 隔离
    runtime-reliability.test.ts    # 迁移 / 序号 / 增量上下文 / durable event / 恢复 / 死锁
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3001` | HTTP 端口 |
| `DATA_DIR` | `.data` | 数据根目录 |
| `GITHUB_TOKEN` | 空 | 留空则用本机 `copilot` CLI 已登录用户 |
| `COPILOT_MODEL` | `gpt-5` | 默认模型 |
| `COPILOT_WARMUP` | `true` | 启动时预热 Copilot client |
| `MAX_DELEGATION_DEPTH` | `4` | `delegation_path` 最大长度 |
| `EXECUTION_TIMEOUT_MS` | `600000` | 单次 turn 上限（SDK 默认 60s 对带工具的真实任务太短） |
| `RECOVER_ON_STARTUP` | `true` | 启动时跑 `RecoveryService`（单进程独占 DB 才安全） |

## 前提

- Node.js >= 22.13（`engines` 要求；`node:sqlite` 会打印一条 experimental 警告，属正常）
- Copilot 认证二选一：本机 `copilot` CLI 已登录，或 `.env` 里填 `GITHUB_TOKEN`
- `@github/copilot-sdk` pin 在 `1.0.14`；升级时需同步验证 runtime 行为

## 后续扩展点

- **执行 API**：`GET /api/executions/:id`、`POST /api/executions/:id/retry`（`TeamService.getExecution()` / `retryExecution()` 已经就绪，只差 route）。
- **多副本**：`RecoveryService` 目前假设单进程独占 DB。多副本前要把 owner 升级成 DB lease。
- **认证**：`local-user` 是占位。接 Entra ID / AD / OIDC 时只改请求上下文，业务数据模型不动。
- **会话记忆 vs Member 记忆**：`conversation_message` 是会话上下文，`members/<id>/memory/MEMORY.md` 是 Member 长期记忆，两者不要混。
- **Member 记忆提案**：让模型用 `propose_member_memory` 提议、由应用审核后再落盘，而不是直接写。
- **前端拆分**：`TeamChat.tsx` 已经偏大，按 sidebar / message list / runtime status / composer 拆组件，并补 Member 编辑器、execution tree 视图。
- 只在真正出现「谁该接这个问题」的规模后，再引入 Member Router（LLM 路由会多一层概率性决策）。
- `coding` profile 上生产前必须补 sandbox。
