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

Conversation 的形状是**不变量，由 Service 层强制**（不是靠 React 约束）：

| kind | 成员数 | 能否增减 |
|------|--------|----------|
| `direct` | 恰好 1 | 不能 |
| `group` | ≥ 2 | 能（`addMember` / `removeMember`，移出后仍须满足 ≥ 2） |
| `work` | 恰好 1 | 不能 |

API 是公开的，所以 `assertConversationKindShape()` 必须挡在 `createConversation` / `addMember` / `removeMember` 里，
而不是指望前端只发合法的请求。

归档（`status = 'archived'`）的语义要分清两件事：

```
roster（历史事实）      —— 归档的 Member 仍然留在 conversation 里，
                          它过去发过的消息和 execution 都还查得到
新的执行目标（新活）    —— 归档的 Member 不接。sendMessage / delegateMember / retry 都会拒
```

所以 `requireConversationMember()`（宽松，认 roster）和 `requireActiveMember()`（严格，拒归档）是两个函数，
`hydrateConversation()` 也**不能**再过滤 `m.status = 'active'` —— 那样会让历史对话凭空少一个人。

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

### 工具授权：声明与放行

「引擎看得见什么」和「这一次调用放不放行」是两件事，很容易各自漂移成两套判据 ——
模型看得见一个它其实用不了的工具，或者更糟：看不见却在某条路径上被放行。
两者都收敛到同一个 `ToolPolicy` 实例（`server/tool-policy.ts`）：

```
availableTools(profile)  →  ToolSet       声明给引擎（它有什么）
hooks.onPreToolUse       →  allow | deny  每次调用重新判一遍（这次能不能用）
```

`check()` 的判定顺序：

| 工具 | 判定 |
|------|------|
| `ask_member` / `message_member` / `remember_member` | 放行 —— 副作用由各自的业务校验兜住 |
| `BuiltInTools.Isolated` | 放行 —— SDK 契约保证只在 session 边界内活动 |
| `bash` / `edit` / `grep` / `web_fetch` | `profile === 'coding'` **且** `HOST_CODING_TOOLS=true` 才放行 |
| 其它一切 | 拒绝 |

最后一条是默认拒绝：引擎新增一个 built-in、或者某个 skill 让模型想调一个没承认过的名字时，
必须在授权层被拦下。`skipPermission: true` 的含义只是「app-owned 工具不必弹权限提示」，
它是省一次交互，不是一次授权；`toolProfile` 同理 —— 成员声明想要什么，不等于允许它做任何事。

一轮 turn 用的是**开始那一刻**的 `toolProfile`（冻结在 `RuntimeExecutionContext` 里）：
中途有人把 profile 从 `safe` 改成 `coding`，不该让正在跑的这一轮突然多出宿主工具。
hook 认不出 `sessionId` 属于哪个 execution 时也拒绝而不是放行 —— 那说明这个 session
不是本进程在跑的一轮 turn，既不知道是谁在用、也不知道属于哪个房间。

放行时返回的是**明确的 `allow`**，不是空对象。空对象是「没有意见」，引擎会接着走它
自己的权限流程，而这个服务里没有可以点「同意」的人 —— 那个请求会一直挂在 pending 上，
直到 `EXECUTION_TIMEOUT_MS` 把一轮正常的工作判成超时。`allow` / `deny` 两边都写出来，
授权就只有 `onPreToolUse` 这一个决策点。

不是由工具调用引起的权限请求（`url` / `mcp` / 扩展管理……）由 `onPermissionRequest`
回答 `user-not-available`：这个服务里没有终端、没有确认框、没有第二个进程在看着，
等一个不会来的答案是纯粹的损失。注意这**不是**默认放行 —— 一个装出来的放宽会让权限层
变成比策略层更弱的一条旁路，那正是策略层想避免的事。

| profile | 声明给引擎的工具 |
|---------|------------------|
| `safe`（默认） | SDK isolated built-ins + `ask_member` + `message_member` + `remember_member` |
| `coding` | 同上；且仅在 `HOST_CODING_TOOLS=true` 时再加 `bash` / `edit` / `grep` / `web_fetch` |

> `coding` 在 `HOST_CODING_TOOLS=true` 且没有 sandbox 时，`bash` 可以触达宿主机边界，
> 不要直接用于多租户生产环境。

## Runtime reliability

「能跑的 Team Agent Demo」和「可靠的 Team Runtime」之间差的是下面几件事。当前实现把它们都收在 `server/` 里，没有引入 K8s sandbox、LLM router、policy service 或 scheduler。

| 问题 | 做法 |
|------|------|
| 没有持久队列，进程一挂就丢 | `execution` 表本身就是队列：`queued` / `running` / `waiting_for_member` / `interrupted`。启动时 `RecoveryService` 做一次保守恢复 |
| SSE 是易失的，断线就丢事件 | 事件先落 `conversation_event` 再广播；SSE 帧带 `id: <sequence>`，浏览器重连时用 `Last-Event-ID` 补发 |
| runtime 锁只在进程内 | per-runtime 串行锁 + `member_runtime.active_execution_id` 持久化视图，重启后能看出「谁在跑」 |
| 会话上下文和 Copilot session history 重复 | `ContextAssembler` 只注入 `message_sequence > last_context_message_sequence` 的新消息 |
| 并发 delegation 会死锁 | `delegation_path` 防同树环 + wait-for 图防跨树互相等待 |
| DB 说失败 / 已取消，引擎还在跑 | `resumeSession` 错误分类收窄 + 超时 `abort()` + `activeSessions` 句柄，让 cancel 能真的落地 |
| 排队中的唤醒经不起重启 | 唤醒的**触发消息序号与原因一起落库**，恢复时原样重派，而不是拿当前水位猜一个 |

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

### 5. 状态分裂：DB 说失败，引擎还在跑

两类「DB 与引擎不一致」的经典来源，都在 `copilot.ts` 里收口：

**a. `resumeSession` 的错误分类必须窄。** 恢复 session 失败时降级成新建，看着很安全，其实是数据丢失：认证失败 / 网络故障 / CLI 起不来都会被误判成「这个 session 不存在」，然后静默开一个空 session，把该 Member 的全部历史丢掉。所以只认明确形态（`session not found` 之类），匹配不上时问一次权威来源 `getSessionMetadata()`（缺失返回 `undefined`）；**连这次查询都失败就原样抛出**，绝不把「引擎坏了」伪装成「这是一轮全新对话」。

**b. `sendAndWait(timeout)` 不是取消。** SDK 文档写得很清楚：timeout 只控制等多久，*does not abort in-flight agent work*。所以超时后必须显式 `session.abort()`，否则 DB 里判 `failed` 而 Agent 仍在跑 —— 正是上面说的状态分裂。

abort 之后还要等一次 `session.idle` 才算「停稳」。注意这里**必须先订阅再 abort**：abort 的 ack 与 `session.idle` 之间有一段空隙，事后订阅会漏掉事件、白等满一个 grace，把「已经停稳」误报成没停。

`activeSessions: Map<executionId, CopilotSession>`（turn 入口 set，`finally` delete）是 `cancel` 能落地的前提 —— 没有这个句柄，`POST /executions/:id/cancel` 只能写个假的 `cancelled`。

### 6. 唤醒是一个可重放的单位

scheduler 的入队单位**就是**落库的重放单位：

```ts
interface PendingWake {
  conversationId: string;
  memberId: string;
  reason: WakeReason;      // direct | mention | open_discussion | follow_up
  triggerSequence: number; // 是哪条消息唤起的
}
```

两者共用同一个形状，是为了让「恢复出来的那一轮」和「当时那一轮」在结构上不可能不一致。
只存一个 `pending_wake` 布尔位时，恢复只能拿当前水位 + 一个猜的原因去重建 —— 结果是
`@bob 看一下风险`（mention @17）被重放成对着第 23 条消息的顺带唤醒。

三处细节：

- **「排队 → 在跑」是一个原子翻转。** `beginWake()`（清 pending）和 `insertExecution()`
  必须在同一个事务里。反过来先清 pending 再建 execution 有一个窗口：进程死在中间，
  唤醒和 execution 会同时消失。
- **合并要整条保留，不能字段级拼装。** `mergeWake()` 若分别取「更明确的 reason」和
  「更大的 triggerSequence」，会拼出一个从未发生的事件（`mention` + 第 11 条消息，
  而第 11 条并没有点名）。正确做法是更明确的 reason 胜出**连同它自己的 trigger**，
  同级取更新的。被丢掉的那条消息不会消失：`ContextAssembler` 注入的是 checkpoint
  以来的全部消息。
- **区分「跑失败了」与「连跑都没跑起来」。** 后者要清掉 durable 标记，否则每次重启
  都会重派一条注定失败的唤醒。scheduler 通过 `run(wake, markStarted)` 回调拿到这个区分。

归档 / 移出 Member 前有三道闸门（未结束的 execution、`pending_wake`/`wake_status`、
scheduler 内存队列），任一条命中就 `409 Conflict` —— 不做「边跑边踢」。移出时
`member_runtime` 行**换 sessionId 而不是删除**（`execution.runtime_id` 引用它且没有
`ON DELETE`），重新加入自然拿到一个全新的 Copilot session，不会 resume 上一段任职的历史。

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
| POST | `/api/conversations/:id/members` | 加入 Member（仅 `group`） |
| DELETE | `/api/conversations/:id/members/:memberId` | 移出 Member（仅 `group`） |
| GET | `/api/conversations/:id/events?since=` | 会话级 SSE（支持 `Last-Event-ID` 回放） |
| GET | `/api/conversations/:id/executions?limit=` | 该会话的 execution，按 `createdAt` 正序（默认 200，夹在 1..1000） |
| GET | `/api/conversations/:id/state` | 房间里每个 Member 的读游标 / 唤醒状态 / 静音 |
| PATCH | `/api/conversations/:id/members/:memberId/state` | 静音 / 取消静音 |
| GET | `/api/members/:id/direct-messages` | 该 Member 参与的全部私聊（只读） |
| GET | `/api/members/:id/memory` · `PUT` | 该 Member 的长期记忆全文 |
| GET | `/api/members/:id/skills` · `POST` · `DELETE` | 该 Member 的 skill（zip 上传 / 卸载） |
| POST | `/api/internal/members/:id/direct-messages` | **以 `:id` 的身份**发私聊 —— Internal API，见下 |
| GET | `/api/executions/:id` | 单条 execution |
| POST | `/api/executions/:id/retry` | `202 { executionId, execution }` —— 新建一条并指回原记录 |
| POST | `/api/executions/:id/cancel` | 等引擎真的停下来才返回最终状态 |

### API 边界：谁在调用

同一个 `:id` 在不同路径下的含义不一样，混在一起就会出问题：

| 边界 | 前缀 | `:id` 的含义 | 调用方 |
|------|------|--------------|--------|
| Human API | `/api/conversations`、`/api/members`（读） | 我在看谁 | 浏览器里的用户 |
| Admin API | `/api/members`（写）、memory、skills | 我在改谁 | 管理员 |
| Internal API | `/api/internal` | **我代表谁** | 另一个 runtime |

`POST /api/internal/members/:id/direct-messages` 里的 `:id` 是调用方自己填的 ——
它长在 `/api/members` 下时，任何能访问这个服务的人都能填别人的 id，效果就是
「替 Alice 发消息」。身份会从一个**校验过的输入**退化成一个**请求参数**。

所以这一组单独挂在 `/api/internal` 下 —— 路径本身也是契约：看到它就知道调用方
不是浏览器，而是另一个 runtime。整组走 `requireInternalToken`：

```
INTERNAL_API_TOKEN 为空    放行（单机原型）。启动日志写「Internal API 未设防」
INTERNAL_API_TOKEN 已配置  要求 Authorization: Bearer <token> 或 X-Internal-Token: <token>
```

Member 自己的三个工具（`message_member` / `ask_member` / `remember_member`）和这条
HTTP 路径是**同一个能力面**，只是一个从引擎里调、一个从外面调，两边的授权判据一致。

### Execution API

Execution 是「一次实际工作」的审计记录，也是用户的操作面：看得见在干什么、失败在哪、然后 retry / cancel。

刻意**不做** `GET /executions/:id/tree`。客户端拿 `parentExecutionId` 自己组树就够了，
服务端算一次树只是在缓存一个随时会变的视图。

`cancel` 的顺序是 **先停引擎，再决定终态**：

| 当前状态 | 行为 |
|----------|------|
| `queued` | 还没进引擎，直接落库 `cancelled`（`runTurn` 开跑前会重新确认状态，不会偷偷跑起来） |
| `running` | `session.abort()` → 等 `session.idle` → 由这一轮的 `runTurn` 自己写成 `cancelled` |
| `waiting_for_member` | `409` —— 第一版不做子树的取消传播 |
| 终态 | `409` |
| 已 `cancelled` | 幂等返回 `200` |

反过来的写法（先 `UPDATE ... status = 'cancelled'` 再 abort）会造出「DB 说已取消、Agent 还在跑」的**假取消**，
比不取消更危险 —— 它让操作者以为副作用已经停了。所以 `cancelExecution()` 在引擎收尾后如果发现状态还是活的，
会直接 `409` 而不是硬写 `cancelled`。

`retry` 同样绝不自动重跑：它生成一条**新的** execution 并用 `retryOfExecutionId` 指回原记录，审计链不断。
（`RecoveryService` 对 `running` 也坚持不自动重跑 —— Copilot session 可能已经执行完工具但没来得及落库，重跑会重复副作用。）

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
| 3 | `conversation_member_state`（Member 在房间里的读游标 + 唤醒状态）、`execution.decision` / `trigger_message_sequence` |
| 4 | `conversation_member_state.pending_wake_trigger_sequence` / `pending_wake_reason`（唤醒的重放单位） |

约定：

- `user_version = 0` 且已存在 `member` 表 → 当作 v1（老库），不重建。
- `user_version = 0` 且库是空的 → 直接建最新版。
- `user_version > SCHEMA_VERSION` → 拒绝启动，避免新数据被老代码写坏。
- 加列一律走 `ADD COLUMN`，不重建表 —— 这几张表被 6 张表 FK 引用，SQLite 改不了它们。
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
  db-migrations.ts            # PRAGMA user_version 迁移（v1 → v4）
  domain.ts                   # Member / Conversation / Runtime / Execution 类型
  copilot.ts                  # MemberRuntime → CopilotSession 执行引擎 + custom tools
  tool-policy.ts              # 工具声明与放行（同一个实例回答两个问题）
  context-assembler.ts        # 增量上下文（message_sequence checkpoint）
  recovery-service.ts         # 启动恢复（保守策略，不自动重跑 running）
  member-service.ts           # 长期 Member 身份 + member home
  conversation-member-service.ts  # 房间内成员状态（读游标 / pending wake / wake_status）
  member-turn-scheduler.ts    # 同一 Member 的 turn 串行化 + 唤醒合并
  team-service.ts             # 核心编排：Conversation / Execution / Delegation / 单写者 / durable event
  app.ts                      # 依赖装配 + 路由挂载
  index.ts                    # 迁移 → 恢复 → listen + 优雅退出
  middleware/
    errorHandler.ts
    apiScope.ts               # Internal API 门禁（三类调用方的边界）
  routes/
    health.ts
    members.ts
    conversations.ts
    executions.ts               # 单条 / 列表 / retry / cancel
    internal.ts                 # 以 Member 身份说话（token 门禁）
  test/
    schemas.test.ts
    tool-policy.test.ts            # 声明了什么 / 放行什么 / 两者不允许漂移
    internal-api.test.ts           # 路径归属 + token 门禁
    team-service.test.ts           # delegation cycle / depth / runtime 隔离 / kind 形状约束
    member-dm.test.ts              # Member ↔ Member 私聊房间唯一性 + 自动对谈抑制
    member-skills.test.ts          # skill 安装 / 卸载 / zip 校验
    runtime-reliability.test.ts    # 迁移 / 序号 / 增量上下文 / durable event / 恢复 / 死锁
    runtime-correctness.test.ts    # resume 分类 / 超时 abort / 工具授权接线 / cancel 状态机 / retry
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
| `GROUP_AUTO_WAKE_ROUNDS` | `2` | 无 `@mention` 的 member 发言最多连着唤醒几轮 |
| `HOST_CODING_TOOLS` | `false` | 是否允许 `bash` / `edit` / `grep` / `web_fetch`。**不随 `toolProfile` 打开** |
| `INTERNAL_API_TOKEN` | 空 | Internal API 门禁；空 = 不校验（仅限本机单用户） |

`HOST_CODING_TOOLS` 默认关闭，原因是这几个工具的工作目录虽然是 conversation workspace，
runtime 仍然是宿主机上的进程 —— 没有沙箱时 `bash` 能走到 workspace 之外。成员把
`toolProfile` 标成 `coding` 只是**声明想要什么**，不等于拿到了宿主机的执行权；
判定要看两道门：`profile === 'coding'` **且** 部署显式启用了宿主工具。打开它等于承认
「当前 runtime 是可信的单租户环境」；多租户必须等沙箱运行时（K8s / Kata / Firecracker）
就位后，由运行时策略而不是这个开关来给工具。

三个 custom tool（`ask_member` / `message_member` / `remember_member`）和 SDK 的
`BuiltInTools.Isolated` 集合始终可用；没定义过策略的工具一律拒绝。

## 前提

- Node.js >= 22.13（`engines` 要求；`node:sqlite` 会打印一条 experimental 警告，属正常）
- Copilot 认证二选一：本机 `copilot` CLI 已登录，或 `.env` 里填 `GITHUB_TOKEN`
- `@github/copilot-sdk` pin 在 `1.0.14`；升级时需同步验证 runtime 行为

## 后续扩展点

- **Execution UI**：`ExecutionStrip` / `ExecutionTree`（客户端按 `parentExecutionId` 组树）+ retry / cancel 按钮，并把 `TeamChat.tsx` 拆成 `src/components/team/`。
- **Member 编辑器**：handle / description / style / systemPrompt / model / toolProfile / status，其中 `coding` 必须显式标注 "Host execution / Not sandboxed"。
- **多副本**：`RecoveryService` 与 `cancelRequests` 目前都假设单进程。多副本前要把「谁是 owner」和取消信号都升级成 DB lease / 跨进程通道。
- **认证**：`local-user` 是占位。接 Entra ID / AD / OIDC 时只改请求上下文，业务数据模型不动。
- **会话记忆 vs Member 记忆**：`conversation_message` 是会话上下文，`members/<id>/memory/MEMORY.md` 是 Member 长期记忆，两者不要混。
- **Member 记忆提案**：让模型用 `propose_member_memory` 提议、由应用审核后再落盘，而不是让 `remember_member` 直接写。
- 只在真正出现「谁该接这个问题」的规模后，再引入 Member Router（LLM 路由会多一层概率性决策）。
- `coding` profile 上生产前必须补 sandbox（`RuntimeAdapter`：Local / K8s / Kata / Firecracker）。
