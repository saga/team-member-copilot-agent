# team-member-copilot-agent

A server-side AI Team platform built on GitHub Copilot SDK.

> 改这个仓库之前先读 [`AGENTS.md`](AGENTS.md)：**不写兼容层、不留旧版本、改 schema 直接改 `SCHEMA_SQL` 并重建库**。

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
                    ┌───────────────────┴───────────────────┐
                    │              Capabilities             │
                    │  SkillProvider  KnowledgeProvider  ToolProvider
                    └───────────────────────────────────────┘
```

Member 的「能用什么」是一组**能力引用**，不是代码里的清单：

```
Member
│
├── Persona（name / role / style / system prompt / model）
├── Memory（长期记忆，全文进 prompt）
│
└── Capabilities（member_capability_binding）
    │
    ├── Skill Providers
    │   ├── team.filesystem-skills      团队共用的程序化方法论
    │   └── member.filesystem-skills    这个 Member 自己的专长
    │
    ├── Knowledge Providers
    │   └── local.filesystem-knowledge  本地文件系统 + FTS（selector = KB key / $personal）
    │
    └── Tool Providers
        ├── team.core-tools             ask_member / message_member / remember_member
        ├── knowledge.tools             search_knowledge / open_knowledge_document
        └── runtime.host-coding-tools   bash / edit / grep / web_fetch（需部署放行）
```

Provider ID 是稳定契约，实现可以替换：把 `local.filesystem-knowledge` 换成企业搜索，
Member 的 binding 一行都不用改。**CopilotService 不认识任何具体 Provider** ——
它只接受一份解析好的 `RuntimeCapabilities`。

## Core model

| 概念 | 含义 |
|------|------|
| **Member** | 业务上的长期 AI 同事。持久身份 + role + style + system prompt + model + 能力组成 + long-term memory。跨 conversation 稳定。 |
| **Capability** | Member 引用哪些 Skill / Knowledge / Tool Provider（`member_capability_binding`）。它是「能用什么」的唯一答案。 |
| **Conversation** | 聊天/协作空间。`direct`（一个 Member）/ `group`（多个 Member）/ `work`（独立工作会话）。 |
| **MemberRuntime** | 某 Member 在某 Conversation 中的运行实例。一个 runtime 拥有一个稳定的 Copilot Session 和一个独立 workspace。 |
| **CopilotSession** | Runtime 的执行引擎状态。**内部实现细节，不是业务对象。** |
| **Execution** | Agent 实际跑了一轮。记录 `parent_execution_id` / `delegation_path` / `external_work_ref`（开始时从 conversation 快照）/ `external_work_snapshot`（开始时向外部系统取证），构成完整审计链。状态：`queued` / `running` / `waiting_for_member` / `completed` / `failed` / `cancelled` / `interrupted`。 |
| **Team** | 顶层协作边界（单 Team 部署，`team_id` 为以后多 Team 留结构）。 |
| **TeamMembership** | 谁属于 Team：`human`（`principalId=user id`，单机为 `LOCAL_ACTOR_ID`）/ `agent`（`principalId=member.id`），`role=owner/admin/member`。`Member.role` 是职业角色，两者绝不合并。 |
| **Jira（外部事实源）** | 业务工作（工单、状态、负责人、工作流）以 Jira 为准，**本地不复制**。本地只有两个值对象：`ExternalWorkRef`（provider/externalId/key/url，挂在 Conversation 与 Execution 上）和 `ExternalWorkSnapshot`（execution 开始时向 Jira 取证的最小字段）。没有 Project / WorkItem / JiraIssue 这些本地业务对象。`Current Work` = active execution → 外部引用。Agent 通过 `atlassian.jira-tools` 读写工单；控制面（取证、webhook 定位房间）走 `WorkManagementProvider` 直连，**不经过 LLM**。 |
| **Presence** | Team 层可接工作状态：落库只有 `available/away/paused`，`busy/offline` 由 active execution / lastSeen 计算。`paused` 只拦自动唤醒，不拦 @ 点名。 |
| **ScheduledWake** | `once` / `interval` 定时唤醒，必须绑定 `work` conversation，且被调度的 Member 必须在该 conversation 里；`UNIQUE(schedule_id, scheduled_for)` 幂等，周期不补历史。执行链固定为 `ScheduledWake → ScheduledWakeRun → Execution → executeMemberTurn`，**不经过 MemberTurnScheduler**（聊天 wake 与 schedule wake 不是同一种 wake，不能 coalesce）；run 的终态随 execution 收口（completed/failed），不停在 running 上没有下文。 |

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

- tools（由能力解析结果推导：`ToolSet` = isolated built-ins + 各 Tool Provider 声明的工具）
- workspace（`.data/workspaces/<conversation-id>/<member-id>/`）
- skills（`skillDirectories` = 各 Skill Provider 解析出来的目录）
- Member 身份（`systemMessage` append）
- delegation（`ask_member`）
- memory（`.data/members/<member-id>/memory/MEMORY.md`）

### 能力解析：一条单向链路

```
MemberCapabilities（binding 列表）
        ↓  CapabilityResolver.resolve(context, capabilities)
RuntimeCapabilities { skills, knowledge, tools, toolIndex, manifestHash }
        ↓  CopilotCapabilityAdapter.build(...)
Copilot SDK session 配置（tools / availableTools / onPreToolUse）
```

链路只有这一条：`TeamService.executeMemberTurn()` 里出现 `resolveCapabilities()` 之后，
引擎拿到的就只有解析结果。任何地方重新去读 `config.teamSkillRoot`、或直接调某个
Knowledge 实现，都会让 `manifestHash` 不再反映这一轮真的用了什么 —— 而那正是事后
回答「这一轮到底用了哪个能力实现」的唯一依据。

解析本身与引擎无关：换掉最后一层（Copilot → DeepAgents / OpenCode / Claude Agent SDK）
只需要重写 `server/capabilities/copilot-adapter.ts`。

### 工具授权：只看声明的性质，不看工具名

「引擎看得见什么」和「这一次调用放不放行」是两件事，很容易各自漂移成两套判据 ——
模型看得见一个它其实用不了的工具，或者更糟：看不见却在某条路径上被放行。
两者都出自**同一份解析结果**（`RuntimeCapabilities`）：

```
availableTools                         声明给引擎（它有什么）
hooks.onPreToolUse → ToolPolicy.check  每次调用重新判一遍（这次能不能用）
```

`DefaultToolPolicy.check()` 的判据只有三个，全部来自 `RuntimeTool` 的声明：

| 判据 | 判定 |
|------|------|
| `requiresHostAccess` 且 `HOST_CODING_TOOLS=false` | 拒绝 |
| `risk === 'privileged'` | 拒绝（必须经过独立 Policy 服务，Provider 自带的 `authorize()` 说了也不行） |
| `risk === 'external-write'` 且无 `authorize()` | 拒绝（默认拒绝：以后加 `send_email` 不会默认允许） |
| `risk === 'external-write'` 有 `authorize()` | 以它的结论为准 |
| `authorize()` 返回拒绝 | 拒绝 |
| 不在 `toolIndex` 里的任何名字 | 拒绝（默认拒绝） |

**没有 `if (toolName === 'bash')`。** 这是这一层最关键的性质：新增一个工具只需要在
Provider 里声明它的 `risk` / `requiresHostAccess`，授权层不动。硬编码工具名的写法会让
每加一个工具都要重新审一遍授权层，第三方 Provider 也就永远无法真正插件化。

`skipPermission: true` 的含义只是「app-owned 工具不必弹权限提示」，它是省一次交互，
不是一次授权。一轮 turn 用的是**开始那一刻**解析出来的能力：中途有人改了 Member 的
绑定，不该让正在跑的这一轮突然多出（或少掉）一个工具。

放行时返回的是**明确的 `allow`**，不是空对象。空对象是「没有意见」，引擎会接着走它
自己的权限流程，而这个服务里没有可以点「同意」的人 —— 那个请求会一直挂在 pending 上，
直到 `EXECUTION_TIMEOUT_MS` 把一轮正常的工作判成超时。`allow` / `deny` 两边都写出来，
授权就只有 `onPreToolUse` 这一个决策点。

不是由工具调用引起的权限请求（`url` / `mcp` / 扩展管理……）由 `onPermissionRequest`
回答 `user-not-available`：这个服务里没有终端、没有确认框、没有第二个进程在看着，
等一个不会来的答案是纯粹的损失。注意这**不是**默认放行 —— 一个装出来的放宽会让权限层
变成比策略层更弱的一条旁路，那正是策略层想避免的事。

| 能力绑定 | 声明给引擎的工具 |
|---------|------------------|
| `team.core-tools` + `knowledge.tools` | SDK isolated built-ins + `ask_member` + `message_member` + `remember_member` + `search_knowledge` + `open_knowledge_document` |
| 再加 `runtime.host-coding-tools` | 同上；且仅在 `HOST_CODING_TOOLS=true` 时再加 `bash` / `edit` / `grep` / `web_fetch` |

> 绑定 `runtime.host-coding-tools` 只是**声明想要**。没有 `HOST_CODING_TOOLS=true` 时，
> 这些工具既不声明给引擎也不放行；`HOST_CODING_TOOLS=true` 且没有 sandbox 时，
> `bash` 可以触达宿主机边界，不要直接用于多租户生产环境。

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
| 网络重试会写出重复消息 | `clientRequestId` 落到唯一索引上，重试命中已有那条并回 `deduplicated: true`（序号不会被重复分配） |
| 两个人同时改同一份记忆 | `MEMORY.md` 的 `version` = 全文 sha256，PUT 带 `expectedVersion`，不匹配 `409` 且不写盘 |
| 上下文无限增长会撑爆 prompt | `ContextAssembler` 按条数 + 字符数双重上限，**从最新往前取**，并在 transcript 前显式说明省略了多少条 |
| 事后看不出「这一轮用的是哪份配置」 | `execution.config_snapshot` 存指纹（memberRevision / model / 各种 hash，含 `capabilityManifestHash`），不存全文 |
| 状态变化没有消息可看，前端只能靠猜 | `conversation_member_state.updated` 落 `conversation_event` 再广播，前端按 `updatedAt` 合并 |

### 1. 崩溃恢复：宁可漏跑，不可重跑

启动顺序是「schema 就位 → provisioning → 恢复 → 重新提交 → listen」。

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

### 7. `POST /messages` 是幂等的

客户端网络重试、用户手抖点两次，都会让同一条消息落两遍。判据是 `clientRequestId`
（不是内容 —— 两次真的发了同一句话是两件事，不是一次重试）：

```ts
sendMessage({ content, clientRequestId })
  ↓
查 (conversation_id, client_request_id)
  ├── 命中 → 202 { message: 已有那条, deduplicated: true }   ← 不分配新序号、不唤醒任何人
  └── 未命中 → 分配序号 → insert
                 └── UNIQUE 冲突（并发重试）→ 回读那条并返回 deduplicated: true
```

三处容易写错的顺序：

- **幂等检查必须在分配 `message_sequence` 之前。** 放到后面会给房间留下一个空号，
  而所有「按序号推断」的东西（未读数、checkpoint 比较）都会看到一个不存在的消息。
- **先检查仍然会漏并发**，所以 `insertMessage` 要接住 `UNIQUE constraint failed` 并回读
  —— 两个请求都过了前置检查时，第二个撞索引才是收口点。判据是 `/UNIQUE constraint failed/i`，
  `errcode === 2067` 只作次选（Node 版本间不保证一致）。
- **前端只在内容不变时复用 key**（`pendingSendRef`）：改了内容再发是一次新发送，
  复用旧 key 会让新内容被静默丢掉。成功才清 ref，失败保留，好让「再点一次」成为真重试。

`replyToMessageId` 同理不能只信请求体：引用的消息不存在 → `400`，属于另一个房间 → `400`。
不校验的话，前端拿到的一个过期 id 会把它变成一个跨房间的信息泄露口。

### 8. 两份记忆与乐观并发

`members/<id>/memory/MEMORY.md` 有两个写者：用户在 UI 里改、Agent 调 `remember_member`。
后写的直接覆盖先写的，会安静地丢掉一段记忆。

```ts
MemberMemory { content: string; version: string }   // version = sha256(content)
PUT /memory { content, expectedVersion? }
  └── expectedVersion 与当前 version 不符 → 409（不写盘）
```

`appendMemory` 也改成读-改-写走同一条写入路径，避免与 `replaceMemory` 的
temp → `fsync` → `rename` 交错。**写盘是原子的**：同目录内 `rename` 才有原子性保证，
所以临时文件必须落在 `MEMORY.md` 旁边，不能丢进系统 temp。

前端（`MemberMemory.tsx`）收到 `409` 时不重试：重新拉一次最新内容作为新基线，
按钮文案变成 `Save anyway`，让「覆盖别人的修改」成为一次显式操作。

memory version / memoryHash / systemPromptHash / capabilityManifestHash 必须是同一个实现，
各写各的会让两个本该相等的指纹永远不相等。

### 9. 一轮 turn 用了哪份配置

配置会漂移：有人在 Member 还跑着的时候改了 system prompt、换了 model、动了能力绑定。
事后只能看到结果，看不出「当时喂进去的是什么」—— 配置快照回答的就是这个。

```ts
ExecutionConfigSnapshot {
  memberRevision, model,
  systemPromptHash, memoryHash, capabilityManifestHash, hostToolsEnabled
}
```

`capabilityManifestHash` 覆盖 skill / knowledge / tool 三层的组成与版本。只记 skill 清单
是不够的：9 月 25 日和 9 月 30 日可以是同一份 system prompt、同一份记忆，但一次用本地
KB、一次用企业搜索 —— 那是两种不同的能力实现，而快照必须能区分它们。

只存指纹不存全文：全文能从 member 行 + 磁盘重算，存两份必然有一份过期。
`memoryHash` 是**整份记忆文件**的指纹，不是「注入了 tail 16000 字符」的指纹 ——
它回答的是「当时是哪一份记忆」，不是「当时塞进去了哪些字节」。

写在 `runTurn()` 里，因为 `systemPromptHash` 依赖「当时真的拼出来的那段 prompt」。
写入失败只 `console.warn` 不抛出（快照是旁证，不是这一轮的输入），但也不能静默。

**retry 不继承原记录的快照**，新记录必须是它自己开跑那一刻的 —— 「配置漂移」正是
对比两次执行的快照才看得出来的东西，继承会把这份证据抹掉。

### 10. 状态变化也是事件

`conversation_member_state` 的每一次变化（读游标推进、`wakeStatus`、`pendingWake`、
静音、被移出）都落 `conversation_event` 再广播：

```
{ type: 'conversation_member_state.updated', data: { memberId, state: ConversationMemberState | null } }
```

否则前端只能靠「消息数变了」猜要不要刷新 —— 而 NO_REPLY、queued、mute 这三种
状态变化**都不伴随新消息**，猜不出来。

三处形状上的选择：

- **`state` 为 `null` 表示「没有了」**（成员被移出）。比再发明一个 event type 干净：
  消费方本来就要处理「这个 memberId 的 state 不存在」。
- **回调签名带 `conversationId`**：状态消失时取不到 conversationId，
  但它仍然属于某个房间的事件流。
- **事务内只攒不广播**。`TeamService.transaction()` 期间 `emit()` 只 `persistEvent`
  并攒进 `deferredEvents`，COMMIT 之后才 `broadcast`；回滚就一起丢掉。
  支持嵌套（内层不再 `BEGIN`），否则内层提交会暴露出外层尚未提交的状态。

前端（`TeamChat.tsx`）按 `updatedAt` 合并而不是直接覆盖：SSE 回放是时间正序，
但首次连接的 `GET /state` 可能后到，没有守卫会「刚 working 又跳回 idle」。

## Default Member Templates

默认团队**不写死在 TypeScript 里**，也不塞进 migration：

```
config/member-templates/
├── financial-solution-architect/
│   ├── member.json          # profile（key/handle/name/role/style/model/capabilities）
│   ├── SYSTEM_PROMPT.md     # 稳定行为与人格
│   └── MEMORY.md            # 初始长期记忆
├── financial-senior-engineer/
└── financial-security-reviewer/
```

| Member | Handle | Role | 能力上的差别 |
|--------|--------|------|--------------|
| Senior Solution Architect | `@architect` | Senior Financial Services Solution Architect | `financial-core` + `architecture-standards` |
| Senior Software Engineer | `@engineer` | Senior Financial Services Software Engineer | `financial-core` + `architecture-standards` + **`runtime.host-coding-tools`** |
| Security Reviewer | `@security` | Financial Services Security & Architecture Reviewer | `financial-core` + `security-controls` |

三个角色共用同一组 skill / tool Provider（`team.filesystem-skills`、`member.filesystem-skills`、
`local.filesystem-knowledge`、`team.core-tools`、`knowledge.tools`），差别只在 knowledge 的
selector 和 Engineer 额外绑定了宿主工具 Provider。

只有 Engineer 默认绑定 `runtime.host-coding-tools`：架构师和 Security Reviewer 不该因为
「自己是这个角色」就获得宿主机代码执行能力。而且绑定本身不等于放行 —— 没有
`HOST_CODING_TOOLS=true` 时，这一组工具既不声明给引擎也不被授权层放行。

### 模板不是 source of truth

```
config/member-templates/     provisioning baseline —— 这个 Member 第一次出现时是什么样
SQLite member                当前真实配置（人格字段）
member_capability_binding    当前能力组成
<member home>/memory/        当前长期记忆
```

启动时执行一次 provisioning：

```
扫描目录 → 解析 member.json → 校验 Provider ID → 按 seedKey 查 member 表
                                                ├── 已存在 → 跳过（不覆盖）
                                                └── 不存在 → 创建 + 写入初始 memory
                                                             + 写入能力绑定
```

四条**不会**发生的事，是这套设计真正的约束：

| 情况 | 行为 |
|------|------|
| 第二次启动 | 全部 `skipped`，不重建 |
| 用户改过 name / handle / system prompt | 不被模板覆盖 |
| Member 已归档 | **不复活** —— 归档是用户明确表达过的意图 |
| 模板文件被改了一版 | 不升级已有 Member（升级应该是显式操作，不是启动副作用） |

所以 `member.seed_key` 必须存在且不可编辑：判据不能是 `handle` / `name` ——
那是用户随时会改的显示属性。按 `handle` 判断的话，用户把 `@architect` 改成
`@solution-architect`，下次重启就会「发现没有 @architect」，于是团队里出现两个架构师。

索引是**部分**唯一索引（`WHERE seed_key IS NOT NULL`）：手工创建的 Member 没有模板来源，
它们的 NULL 之间不能互相冲突。

### 加一个角色不需要改代码

新增 `Research Analyst` / `Portfolio Specialist` / `Compliance Reviewer`：
只加一个目录。`server/member-template-seeder.ts` 里没有一行业务内容 ——
它只回答「这份模板对应的 Member 是否存在」。

模板目录可以指到别处：

```env
MEMBER_TEMPLATES_DIR=/etc/team-member/templates
SEED_DEFAULT_MEMBERS=false    # 代码带着模板，但不要自动建人
```

配置错误（重复的 key、`systemPromptFile` 指向模板目录之外、`member.json` 非法、
引用了未注册的 Provider）**直接让启动失败**，不静默跳过 ——
否则症状是「默认团队少两个人但服务照常起来了」。

模板的 `member.json` 用 `capabilities` 声明能力组成，它**只描述引用，不描述实现**：

```json
"capabilities": {
  "skills":    [{ "providerId": "team.filesystem-skills" }],
  "knowledge": [{ "providerId": "local.filesystem-knowledge", "selector": "financial-core" }],
  "tools":     [{ "providerId": "team.core-tools" }]
}
```

所以模板不知道自己被哪个后端服务：把 `local.filesystem-knowledge` 的实现换成企业搜索，
这三份模板一个字都不用改。绑定只发生在创建那一刻，之后完全归
`PUT /api/capabilities/members/:id` 管 —— 重启不会把用户解绑的能力绑回去。

## Knowledge Base

专业度分层里「知道什么」的部分，与 Skill / Memory 的分界：

```
Skill    = How     少量程序化方法论，进 session context（skillDirectories）
KB       = What    大量事实资料，按需检索，永不全量进 prompt
Memory   = 这个 Member 学到的动态事实，小而常变，全文进 prompt
```

KB 由 `local.filesystem-knowledge` 这个 **Provider** 实现，不是平台级的 Knowledge 服务。
`knowledge_base` / `knowledge_document` / `knowledge_document_fts` 三张表是它的内部存储：

```
.data/team/knowledge/<key>/**      team KB：目录即 KB（key = 目录名），文件即文档
.data/members/<id>/knowledge/      该 Member 的 personal KB
```

什么算「一份可索引的资料」只在一处定义（`providers/knowledge-document-limits.ts`），
扫目录与 API 写入共用同一个判据：扩展名白名单（`.md` `.markdown` `.mdx` `.txt`
`.json` `.yaml` `.yml`）+ 单份不超过 1 MB。两边共用是刻意的 —— 一边接受、一边
拒绝是「文件系统与索引不一致」最常见的形态。被跳过的文件会在启动日志里留下
原因（`格式不对` / `超过上限`），而不是悄悄消失。

把文件放进目录即可被检索（启动时按 content hash 幂等索引），`POST /api/knowledge/...`
写入的文档落在同一棵树上。权限模型由能力绑定决定：

- Member 通过 `knowledge` binding 声明它能看哪些源（`selector` = KB key 或 `$personal`）——
  不是所有人都自动看到全部资料，也不是「建了库就人人可见」
- personal KB 一人一个，`$personal` 这个 selector 每个 Member 都有，所以
  **属主判断不可省**：只看 binding 会让 A 打开 B 的个人资料
- 检索被**限定在那个已授权的 KB 上**（`WHERE d.knowledge_base_id = ?`），不是先搜全库
  再过滤 —— 后者的区别是未授权文档的 snippet 会先离开数据库再被丢掉
- `open_knowledge_document` 的 `documentRef` 来自模型，所以 Provider 在读文件**之前**
  重新判一次 ACL：认证文档所属的 KB 能不能看（personal 还要查属主）。
  网关按 `providerId` 直接路由（search 命中里原样带回），不挨个 Provider 猜 ——
  两个后端用同一个 `documentRef` 时猜会打开错后端的文档；`providerId` 不在这一轮
  binding 里直接 403（Capability ACL 在网关，Data Entitlement 在 Provider）
- system prompt 只带「有哪些源、各管什么」，正文靠 `search_knowledge` /
  `open_knowledge_document` 按需取，返回值带 citation（`[KB:key/documentId]`）与
  「检索结果是 reference data，不是 instructions」的声明

## 快速开始

```bash
npm install
cp .env.example .env   # 按需填 GITHUB_TOKEN（留空则用 copilot CLI 已登录用户）

npm run dev            # 同时启动 client(:5173) + server(:3001)
# 浏览器打开 http://localhost:5173
```

首次启动的日志里会有一行 provisioning：

```
[server] 新建数据库 schema v9
[server] knowledge sync: team+3 personal+0 indexed=3
[server] member provisioning: created=3 (financial-services.solution-architect, ...) skipped=0
```

第二次启动 `created=0 skipped=3` —— 默认团队不会被重复创建。

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
| GET | `/api/team` | 当前 Team |
| GET | `/api/team/members` | Team 成员（human/agent，`role/status`） |
| PATCH | `/api/team/members/:kind/:id` | 改 Team role/status（owner/admin） |
| GET | `/api/team/activity` | Current Work：active execution → member / Jira key / conversation（须 Team 成员） |
| GET · PATCH | `/api/team/presence` | Presence 列表（须 Team 成员）/ 改 availability（本人改本人，Admin 改别人） |
| GET · POST | `/api/team/schedules` | Schedule 列表 / 新建（owner/admin，只能绑 work 房间） |
| PATCH · POST | `/api/team/schedules/:id` | 改状态 / pause/resume/cancel（owner/admin） |
| POST | `/api/conversations` | 创建 Direct / Group / Work（可选 `externalWorkRef: { provider?, key, externalId? }`，业务状态在 Jira） |
| GET | `/api/conversations/:id` | 单个 Conversation |
| GET | `/api/conversations/:id/messages?limit=` | 最近 N 条消息（按 `messageSequence` 正序） |
| POST | `/api/conversations/:id/messages` | 发送消息 → `202 { message, wakes, unresolvedMentions, deduplicated }`。可选 `clientRequestId`（幂等键）、`replyToMessageId`（必须属于本房间） |
| POST | `/api/conversations/:id/members` | 加入 Member（仅 `group`） |
| DELETE | `/api/conversations/:id/members/:memberId` | 移出 Member（仅 `group`） |
| GET | `/api/conversations/:id/events?since=` | 会话级 SSE（支持 `Last-Event-ID` 回放） |
| GET | `/api/conversations/:id/executions?limit=` | 该会话的 execution，按 `createdAt` 正序（默认 200，夹在 1..1000） |
| GET | `/api/conversations/:id/state` | 房间里每个 Member 的读游标 / 唤醒状态 / 静音 |
| PATCH | `/api/conversations/:id/members/:memberId/state` | 静音 / 取消静音 |
| GET | `/api/members/:id/direct-messages` | 该 Member 参与的全部私聊（只读） |
| GET | `/api/members/:id/memory` · `PUT` | 该 Member 的长期记忆 → `{ content, version }`；`PUT` 可带 `expectedVersion`，不匹配 `409` |
| GET | `/api/members/:id/skills` · `POST` · `DELETE` | 该 Member 的 skill（zip 上传 / 卸载）—— 「磁盘上装了什么」，不是「启用了哪个能力来源」 |
| GET | `/api/capabilities/members/:memberId` · `PUT` | 该 Member 的能力组成（skill / knowledge / tool 的 Provider 引用）。**「能用什么」的唯一写入口** |
| GET | `/api/capabilities/providers` | 平台已注册的 Provider 清单（`{ kind, id, version }`，owner/admin）—— 管理界面列选项用 |
| GET | `/api/knowledge/team` · `POST` | team KB 清单 / 新建（`{ key, name, description }`）—— `local.filesystem-knowledge` 的管理面 |
| POST | `/api/knowledge/bases/:kbId/documents` | 写文档（落盘 + FTS 索引） |
| POST | `/api/internal/members/:id/direct-messages` | **以 `:id` 的身份**发私聊 —— Internal API，见下 |
| GET | `/api/executions/:id` | 单条 execution |
| POST | `/api/executions/:id/retry` | `202 { executionId, execution }` —— 新建一条并指回原记录 |
| POST | `/api/executions/:id/cancel` | 等引擎真的停下来才返回最终状态 |
| GET | `/api/work-management/providers` | 已接入的外部工作系统（`{ providers: ['jira'] }`）—— 前端据此决定要不要显示工单字段 |
| POST | `/api/work-management/jira/webhook` | Jira webhook → **最小投影**：按 key / 不可变 id 找到挂着这条工单的房间，发一条 `external_work.changed`（只说「变了哪些字段」）。不写工单内容、不轮询。见下 |

### API 边界：谁在调用

同一个 `:id` 在不同路径下的含义不一样，混在一起就会出问题：

| 边界 | 前缀 | `:id` 的含义 | 调用方 |
|------|------|--------------|--------|
| Human API | `/api/conversations`、`/api/members`（读）、`/api/team`（读） | 我在看谁 | 浏览器里的用户 |
| Admin API | `/api/members`（写）、memory、skills、capabilities、knowledge、schedules、membership、activity | 我在改谁 | Team owner/admin（或 `ADMIN_API_TOKEN`，Agent 永不直接授 admin） |
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

**Agent 身份只有这一个注入点**：`/api/internal/members/:id/**` 的请求由路由把
`:id` 写进 `req.agentMemberId`，Team API 的 `resolveActor` 只认这个字段。
普通 `/api` 路径没有任何中间件写它，所以「请求头塞个 agent id 就变成 Agent」
在这条边界上不存在（Agent 身份一律由 Internal API token + 路径身份一致性校验，伪造不了）。

Admin 写入（`PUT /api/capabilities/members/:id`、`POST /api/knowledge/team`、
`POST /api/knowledge/bases/:id/documents`、`POST/DELETE /api/members/:id/skills`、
`POST /api/members`、`PATCH /api/members/:id` 带 `status`）走 `ADMIN_API_TOKEN`：

```
ADMIN_API_TOKEN 为空    放行（单机原型）。启动日志写「Admin API 未设防」
ADMIN_API_TOKEN 已配置  要求 Authorization: Bearer <token>（与 Internal 共用读 token 逻辑）
```

读（`GET capabilities`、`GET knowledge/team`、`GET members`、`GET skills`、
改名/人设的 `PATCH` 不带 `status`）留在 Human API，不需要 Admin token。
改的是 capability boundary 的写入必须设防，否则普通调用方就能给 Member 绑上
`runtime.host-coding-tools`。

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
  ├── id: 5  conversation_member_state.updated
  └── id: 6  delegation.finished
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
  "model": "gpt-5"
}
```

新建的 Member 自动获得默认能力组成（团队 skill、个人 skill、个人资料库、协作与检索
工具）。要调整它（比如给它开宿主工具），走能力接口：

```json
PUT /api/capabilities/members/researcher-id
{
  "skills":    [{ "providerId": "team.filesystem-skills" }],
  "knowledge": [{ "providerId": "local.filesystem-knowledge", "selector": "$personal" }],
  "tools":     [{ "providerId": "team.core-tools" }, { "providerId": "knowledge.tools" }]
}
```

Provider ID 拼错会直接 `400`（写之前先对注册表校验），而不是等到下一轮 turn 才发现
「这个人少了检索能力」。

Direct Chat：

```json
{ "kind": "direct", "memberIds": ["researcher-id"] }
```

Group Chat：

```json
{
  "kind": "group",
  "title": "Investment Review Team",
  "memberIds": ["researcher-id", "coder-id", "reviewer-id"]
}
```

`group` **不接受** `defaultMemberId`（传了直接 `400`）：收件人由 `GroupDispatcher`
按 @mention 决定，留一个「默认谁接」的值只会让人以为它可以依赖。

发消息时用 `targetMemberId` 决定谁回应（不做 LLM router，保持确定性）：

```json
{ "content": "请 @coder 根据这个结论写一个验证脚本", "targetMemberId": "coder-id" }
```

`@mention` 的解析只做**精确匹配**，且 handle 优先于 name：

```
@<token>  →  byHandle.get(token) ?? byName.get(token)
             两者都没有 → unresolved（不广播给全员）
```

不做前缀匹配（`@ann` 命中 `anna`）也不做「最长名字胜出」：token 里带空格时后者
会让解析结果取决于谁的名字更长。`@Alice Chen` 会被截成 `Alice`，取不出来就进
`unresolved` —— 这是一个取舍，不是缺陷：允许空格会让 `@Alice and Bob please look`
变成一句有歧义的句子，而且没有正确答案。

## Storage

不需要 PostgreSQL，也不需要 ORM。Node >= 22.13 直接用内置 `node:sqlite`。

```
.data/
├── team-member.db                     # member / member_capability_binding / conversation /
│                                      # conversation_member / conversation_message /
│                                      # member_runtime / execution / conversation_event /
│                                      # knowledge_base / knowledge_document(+fts) /
│                                      # team / team_membership / team_event /
│                                      # team_presence / scheduled_wake(+run)
├── members/
│   └── <member-id>/
│       ├── SOUL.md                    # role / description / style / system prompt
│       ├── memory/MEMORY.md           # 长期记忆（remember_member 写入）
│       ├── skills/                    # member.filesystem-skills 的根目录
│       └── knowledge/                 # 该 Member 的 personal KB（$personal）
├── team/
│   ├── skills/                        # team.filesystem-skills 的根目录
│   └── knowledge/<kb-key>/**          # team KB 的正文
├── workspaces/
│   └── <conversation-id>/
│       └── <member-id>/AGENTS.md      # 每个 runtime 独立 workspace
└── copilot/                           # Copilot session state
```

### Schema：只有一个形状，没有迁移

用 `PRAGMA user_version` 登记形状，不引入 migration framework（`server/db-migrations.ts`）。

```
空库              → 建 SCHEMA_SQL
user_version 相等  → 什么都不做
其它              → 拒绝启动
```

`SCHEMA_SQL` 按**最终形状**写一次，没有 `migrateV1ToV2()` 这样的升级链。改 schema 的流程就是：

```
改 SCHEMA_SQL  →  rm -rf .data  →  重启（默认 Member 会重新 provision）
```

不留迁移代码是有意的：迁移只在升级那一瞬间被走到，是日常测试永远不会覆盖的一小段路径。宁可在启动时明确报错，也不要维护一条没人验证的升级路径。代价是**库的形状一旦不对就只能重建**，所以这个项目不承诺「老库能升上来」。

拒绝启动时两个方向给的建议不一样：

| 情况 | 提示 |
|---|---|
| 库比程序旧 | 删掉数据目录重建（默认团队会重新 provision） |
| 库比程序新 | 换回较新的 build —— **不要**删库，那是用户的数据 |

另外两条约束：

- 空库必须**真的空**。有表却没有 `user_version` 登记 → 拒绝，不当成空库去建表（否则会在别人的库上盖一半 schema）。
- 建表与登记版本在同一个事务里。中途失败留一个「有表但 version=0」的库，下次启动会走到上面那条分支，而它给出的建议是换目录 —— 明明重建就行。

幂等键的 `UNIQUE` 索引**允许 NULL**，而且这是刻意的：SQLite 认为 NULL 互不相等，所以不带 `clientRequestId` 的内部消息（Member 回复、委派结果）天然不参与去重，不需要额外分支。

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
config/
  member-templates/           # 默认 Member 模板（provisioning baseline，不是运行时数据）
    financial-solution-architect/
    financial-senior-engineer/
    financial-security-reviewer/

src/                          # Vite + React + Ant Design 前端
  App.tsx                     # ConfigProvider + Layout（Header/Content）
  index.css                   # 仅保留布局级覆盖，组件样式走 antd token
  components/
    HealthBadge.tsx           # antd Badge（success/warning/error）
    TeamChat.tsx              # 编排：conversation / SSE / 状态合并（Layout Sider/Content + Alert/Tag）
    team/                     # TeamChat 的拆分：list / messages / composer / 各编辑面板
      TeamSidebar.tsx         # Collapse 四分区：Members/Current Work/Schedules/Conversations
      TeamSections.tsx        # CurrentWorkSection（active execution → Jira key）
      ConversationList.tsx    # antd List（Tag 区分 private/group/work/direct）
      ConversationMessages.tsx  # @ant-design/x Bubble.List + Timeline（delegation）
      MessageComposer.tsx     # @ant-design/x Sender
      ConversationHeader.tsx  # Avatar.Group + Tag + Select
      GroupMemberManager.tsx  # antd Table（有未完成工作时禁止 Remove）
      MemberEditor.tsx        # antd Form + Collapse（Capabilities 只读）+ Popconfirm Archive
      MemberMemory.tsx        # 乐观并发（409 → Save anyway）
      MemberProfile.tsx       # antd Modal + Tabs
      ...
  lib/api.ts                  # 后端 API 客户端（含 SSE 解析）

server/                       # Express + Copilot SDK 后端
  config.ts                   # 环境变量
  db.ts                       # node:sqlite 打开 + 确保形状
  db-migrations.ts            # 唯一一份 SCHEMA_SQL + 形状检查（无迁移链）
  domain.ts                   # Member / Capability / Conversation / Runtime / Execution 类型
  content-hash.ts             # hashText() —— memory version / 各种 snapshot hash 的唯一实现
  copilot.ts                  # MemberRuntime → CopilotSession 执行引擎（不认识任何 Provider）
  tool-policy.ts              # 工具授权：只看 RuntimeTool 声明的 risk / requiresHostAccess
  context-assembler.ts        # 增量上下文（message_sequence checkpoint）
  recovery-service.ts         # 启动恢复（保守策略，不自动重跑 running）
  member-service.ts           # 长期 Member 身份 + member home + seedKey
  member-template-seeder.ts   # 模板 provisioning（不含任何业务内容，也不认识任何后端）
  capabilities/               # 能力层：Member 引用哪些 Provider
    types.ts                  #   SkillProvider / KnowledgeProvider / ToolProvider 契约
    registry.ts               #   Provider 注册表（重复注册 / 未注册都直接抛）
    service.ts                #   member_capability_binding 读写 + hasKnowledgeBinding（ACL 判据）
    resolver.ts               #   binding → RuntimeCapabilities（含 manifestHash）
    defaults.ts               #   新建 Member 的默认能力组成
    copilot-adapter.ts        #   RuntimeCapabilities → SDK session 配置（唯一认识 SDK 的地方）
    providers/
      filesystem-skill.ts     #     team / member 两级 skill 目录
      filesystem-knowledge.ts #     本地 KB：FTS5 检索 + 磁盘同步 + ACL（原 knowledge-service.ts）
      knowledge-document-limits.ts  # 什么算「一份可索引的资料」（扫目录与 API 写入共用）
      core-tools.ts           #     ask_member / message_member / remember_member
      knowledge-tools.ts      #     search_knowledge / open_knowledge_document
      host-tools.ts           #     bash / edit / grep / web_fetch（需部署放行）
  conversation-member-service.ts  # 房间内成员状态（读游标 / pending wake / wake_status）
  member-turn-scheduler.ts    # 同一 Member 的 turn 串行化 + 唤醒合并
  team-service.ts             # 核心编排：Conversation / Execution / Delegation / 单写者 / durable event
  app.ts                      # 依赖装配 + 路由挂载
  index.ts                    # schema 就位 → provisioning → 恢复 → listen + 优雅退出
  middleware/
    errorHandler.ts
    apiScope.ts               # Internal API 门禁（三类调用方的边界）
  routes/
    health.ts
    members.ts
    capabilities.ts             # 能力组成（skill / knowledge / tool 的 Provider 引用）
    conversations.ts
    executions.ts               # 单条 / 列表 / retry / cancel
    internal.ts                 # 以 Member 身份说话（token 门禁）
    knowledge.ts                # local.filesystem-knowledge 的管理面（建库 / 写文档）
  test/
    schemas.test.ts
    capabilities.test.ts           # Provider 隔离 / 未知 Provider / 同名冲突 / manifest hash / open 二次 ACL
    tool-policy.test.ts            # 只看 risk 与部署许可，不看工具名 / 声明与放行不允许漂移
    internal-api.test.ts           # 路径归属 + token 门禁
    team-service.test.ts           # delegation cycle / depth / runtime 隔离 / kind 形状约束
    member-dm.test.ts              # Member ↔ Member 私聊房间唯一性 + 自动对谈抑制
    member-skills.test.ts          # skill 安装 / 卸载 / zip 校验
    runtime-reliability.test.ts    # schema 形状 / 序号 / 增量上下文 / durable event / 恢复 / 死锁
    runtime-correctness.test.ts    # resume 分类 / 超时 abort / 工具授权接线 / cancel 状态机 / retry
    team-chat.test.ts              # 产品行为：direct / group / @mention / NO_REPLY / persona 与 memory 隔离
    data-integrity.test.ts         # replyTo 校验 / 消息幂等 / 记忆乐观并发 / 上下文上限 / 配置快照 / state 事件 / mention 精确匹配
    member-template-seeder.test.ts # provisioning 幂等 / 不覆盖已改 Member / 归档不复活 / 穿越与重复 key / 能力绑定
    knowledge-provider.test.ts     # 检索范围限定在授权的 KB / personal 隔离 / 路径与 FTS 注入 / 索引幂等 / 磁盘同步
    team-v1.test.ts                # Team/Membership/Presence/Scheduler(prompt 保真+单 execution+run 收口+恢复)/Jira 引用与 Current Activity

scripts/
  mutation-check.py           # 变异验证：把跨层不变量改回错误写法，确认断言真的变红（AGENTS.md §7）
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
| `MAX_CONTEXT_MESSAGES` | `100` | 注入 prompt 的 shared message 条数上限（从最新往前取，至少 1 条） |
| `MAX_CONTEXT_CHARS` | `60000` | 注入 prompt 的字符数上限（含每条 32 字符的固定开销），与条数上限同时生效 |
| `HOST_CODING_TOOLS` | `false` | 是否允许 `bash` / `edit` / `grep` / `web_fetch`。**不随能力绑定打开** |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` | 空 | Jira Cloud 连接。三项齐了才注册 `atlassian.jira-tools`（jira_search / jira_get_issue / jira_add_comment / jira_transition_issue）并让控制面能取证；不配置则本地只有引用、没有工单工具，execution 也不会有 `external_work_snapshot` |
| `JIRA_WEBHOOK_SECRET` | 空 | Jira webhook 的共享密钥（`X-Jira-Webhook-Secret` 头）。空 = 端点无门禁（仅限本机单用户） |
| `INTERNAL_API_TOKEN` | 空 | Internal API 门禁；空 = 不校验（仅限本机单用户） |
| `ADMIN_API_TOKEN` | 空 | Admin 写入（capabilities / knowledge 管理 / skills 安装 / 建 Member / 归档）门禁；空 = 不校验（仅限本机单用户）。Team owner/admin 与 token 任一通过 |
| `TEAM_NAME` | `AI Team` | 默认 Team 名，启动 ensure，不提供新建入口 |
| `LOCAL_ACTOR_ID` | `local-user` | 无用户系统时 human actor 占位 |
| `SCHEDULER_INTERVAL_MS` | `2000` | Scheduler tick 间隔（once + interval，不做 Calendar/RRULE） |
| `MEMBER_TEMPLATES_DIR` | `config/member-templates` | 默认 Member 模板目录（provisioning baseline） |
| `SEED_DEFAULT_MEMBERS` | `true` | 启动时执行 Member provisioning；关闭 = 代码带着模板但不自动建人 |

`HOST_CODING_TOOLS` 默认关闭，原因是这几个工具的工作目录虽然是 conversation workspace，
runtime 仍然是宿主机上的进程 —— 没有沙箱时 `bash` 能走到 workspace 之外。给 Member 绑定
`runtime.host-coding-tools` 只是**声明想要什么**，不等于拿到了宿主机的执行权；判定在
`DefaultToolPolicy.check()` 里看 `requiresHostAccess` + 这个开关。打开它等于承认
「当前 runtime 是可信的单租户环境」；多租户必须等沙箱运行时（K8s / Kata / Firecracker）
就位后，由运行时策略而不是这个开关来给工具。

工具授权**不看工具名**：`ask_member` / `message_member` / `remember_member` /
`search_knowledge` / `open_knowledge_document` 由各自的 Provider 声明，SDK 的
`BuiltInTools.Isolated` 恒可用；没被任何 Provider 声明过的名字一律拒绝。

> Skill selector 语义：`selector` 为空 = 该 Provider 下全部 skill；否则是 skill 目录名
> 清单（逗号/空白分隔，如 `research, security-review`），只加载点名的。Skill 版本是
> 整个目录（相对路径 + 文件内容）的指纹，`scripts/` / `references/` 变化也换版本。
>
> 启动时除模板校验外，还对已有 DB 里全部 Member 的 capability binding 做一次
> `validateAllMemberCapabilities()`：库里留着当前 build 未注册的 Provider 会直接
> 拒绝启动，不等到 turn 才炸。

## 前提

- Node.js >= 22.13（`engines` 要求；`node:sqlite` 会打印一条 experimental 警告，属正常）
- Copilot 认证二选一：本机 `copilot` CLI 已登录，或 `.env` 里填 `GITHUB_TOKEN`
- `@github/copilot-sdk` pin 在 `1.0.14`；升级时需同步验证 runtime 行为

## 后续扩展点

- **Execution UI**：`ExecutionStrip` / `ExecutionTree`（客户端按 `parentExecutionId` 组树）+ retry / cancel 按钮。`TeamChat.tsx` 已拆到 `src/components/team/`，但 execution 视图还没有独立组件。
- **多副本**：`RecoveryService` 与 `cancelRequests` 目前都假设单进程。多副本前要把「谁是 owner」和取消信号都升级成 DB lease / 跨进程通道。
- **认证**：`local-user` 是占位。接 Entra ID / AD / OIDC 时只改请求上下文，业务数据模型不动。
- **会话记忆 vs Member 记忆**：`conversation_message` 是会话上下文，`members/<id>/memory/MEMORY.md` 是 Member 长期记忆，两者不要混。
- **Member 记忆提案**：让模型用 `propose_member_memory` 提议、由应用审核后再落盘，而不是让 `remember_member` 直接写。
- **Restore to template**：把某个 Member 恢复成模板 baseline（含 preview diff）。provisioning 刻意不做这件事 —— 它必须是显式操作，不能是启动副作用。届时再引入 `templateRevision` / `profileRevision`。
- 只在真正出现「谁该接这个问题」的规模后，再引入 Member Router（LLM 路由会多一层概率性决策）。
- `coding` profile 上生产前必须补 sandbox（`RuntimeAdapter`：Local / K8s / Kata / Firecracker）。
