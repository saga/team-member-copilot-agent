# team-member-copilot-agent：前面问题的完整修改清单与代码

基线：当前 `main`，package version `0.4.6`。

目标：先把正确性 / 身份 / 授权 / 审计 / 调度恢复这些大问题补齐；不引入 Temporal/BPMN。

---

## 0. 修改总表

### 必须立即改

| 优先级 | 文件 | 修改 |
|---|---|---|
| P0 | `package.json` | 增加 `jose`，接 OIDC/JWT |
| P0 | `server/auth/identity.ts` | 新增真实 Human Principal |
| P0 | `server/middleware/auth.ts` | 新增 `requireHumanAuth()` |
| P0 | `server/middleware/teamScope.ts` | 不再用 `LOCAL_ACTOR_ID` 作为真实身份 |
| P0 | `server/routes/conversations.ts` | Team + Conversation ACL |
| P0 | `server/routes/executions.ts` | Execution 对应 Conversation ACL |
| P0 | `server/routes/tasks.ts` | Task 对应 Conversation ACL |
| P0 | `server/app.ts` | Human API 全部挂认证 |
| P0 | `server/index.ts` | 启动时禁止生产环境继续使用 local identity |
| P1 | `server/domain.ts` | `member_message` turn/wake |
| P1 | `server/team-service.ts` | Member DM 不再当 Lead turn |
| P1 | `server/task-orchestrator.ts` | 同 Member 一轮只 reserve 一个 ready task |
| P1 | `server/team-service.ts` | `@A @B @C` 改成并行，不再隐式串行 |
| P1 | `server/experience-store.ts` | 默认 member scope；team scope 必须审批 |
| P1 | `server/capabilities/providers/core-tools.ts` | `learn_experience` 默认 member |
| P1 | `server/mcp/service.ts` | DB 不再存真实 secret |
| P1 | `server/capabilities/types.ts` | ToolDecision 加 policy/entitlement metadata |
| P1 | `server/policy.ts` | 持久化 PolicyDecision |
| P1 | `server/audit-service.ts` | 新增 ToolExecution / PolicyDecision audit |
| P1 | `server/capabilities/copilot-adapter.ts` | custom tool 真正执行前后写 audit |
| P1 | `server/copilot.ts` | MCP / permission / tool policy 都写 audit |
| P1 | `server/db-migrations.ts` | audit / entitlement / command / lease 表 |
| P1 | `server/entitlement-service.ts` | 新增 Data Entitlement |
| P1 | `server/tool-policy.ts` | Capability → Entitlement → Policy 三层判定 |
| P1 | `server/command-service.ts` | 新增 Command + Approval 骨架 |
| P1 | `server/capabilities/providers/jira-tools.ts` | Jira write 先 Command，再执行 |
| P1 | `server/work-management/jira-provider.ts` | 支持 resourceVersion/条件执行 |
| P1 | `server/domain.ts` | ExecutionConfigSnapshot 增加完整快照 |
| P1 | `server/team-service.ts` | config snapshot 保存 canonical JSON + hash |
| P1 | `server/recovery-service.ts` | lease 语义 |
| P1 | `server/scheduler-service.ts` | claim/lease/heartbeat |

### 第二批

| 优先级 | 文件 | 修改 |
|---|---|---|
| P2 | `server/team-service.ts` | 拆 Conversation/Task/Execution/Collaboration |
| P2 | `server/routes/*` | 把 route authorization 移到统一 middleware |
| P2 | `server/member-turn-scheduler.ts` | 从内存 pending 迁到 durable queue |
| P2 | `server/routes/work-management.ts` | webhook 继续单独走 secret |
| P2 | 删除/保留 | `lead_bootstrap` 后续可移除 |

---

# 1. Human Authentication

## 1.1 package.json

安装：

```bash
npm i jose
```

`package.json` 不手写固定版本，直接让 npm 写当前版本。

---

## 1.2 新增 `server/auth/identity.ts`

```ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { config } from '../config.js';

export interface AuthPrincipal {
  kind: 'human';
  principalId: string;       // OIDC sub
  displayName?: string;
  email?: string;
  claims: JWTPayload;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!config.oidc.jwksUrl) {
    throw new Error('OIDC_JWKS_URL 未配置');
  }
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.oidc.jwksUrl));
  }
  return jwks;
}

export async function authenticateHuman(req: Request): Promise<AuthPrincipal> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    if (config.authDevMode) {
      return {
        kind: 'human',
        principalId: config.localActorId,
        displayName: 'Local Dev User',
        claims: { sub: config.localActorId },
      };
    }
    throw new Error('缺少 Bearer token');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new Error('Bearer token 为空');

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
  });

  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('OIDC token 缺少 sub');
  }

  return {
    kind: 'human',
    principalId: payload.sub,
    displayName:
      typeof payload.name === 'string'
        ? payload.name
        : typeof payload.preferred_username === 'string'
          ? payload.preferred_username
          : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    claims: payload,
  };
}
```

---

## 1.3 新增 `server/middleware/auth.ts`

```ts
import type { NextFunction, Request, Response } from 'express';
import { authenticateHuman, type AuthPrincipal } from '../auth/identity.js';

declare global {
  namespace Express {
    interface Request {
      principal?: AuthPrincipal;
    }
  }
}

export function requireHumanAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    void authenticateHuman(req)
      .then((principal) => {
        req.principal = principal;
        next();
      })
      .catch((error) => {
        res.status(401).json({
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
}

export function currentPrincipal(req: Request): AuthPrincipal {
  if (!req.principal) {
    throw new Error('当前请求未认证');
  }
  return req.principal;
}
```

---

## 1.4 `server/config.ts`

在 config 中增加：

```ts
authDevMode: env('AUTH_DEV_MODE', 'false') === 'true',

oidc: {
  issuer: env('OIDC_ISSUER', ''),
  audience: env('OIDC_AUDIENCE', ''),
  jwksUrl: env('OIDC_JWKS_URL', ''),
},
```

生产环境检查：

```ts
if (!config.authDevMode) {
  if (!config.oidc.issuer || !config.oidc.audience || !config.oidc.jwksUrl) {
    throw new Error(
      '生产模式必须配置 OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URL',
    );
  }
}
```

`LOCAL_ACTOR_ID` 只能用于：

```text
AUTH_DEV_MODE=true
```

不能作为生产身份。

---

# 2. Team / Conversation Authorization

## 2.1 修改 `server/middleware/teamScope.ts`

保留 Agent internal identity，但 Human 改为从 `req.principal` 读取。

```ts
import { currentPrincipal } from './auth.js';

export function resolveActor(req: Request): ActorContext {
  const agentId = (req as { agentMemberId?: unknown }).agentMemberId;

  if (typeof agentId === 'string' && agentId) {
    return {
      kind: 'agent',
      principalId: agentId,
    };
  }

  return {
    kind: 'human',
    principalId: currentPrincipal(req).principalId,
  };
}
```

删除：

```ts
return { kind: 'human', principalId: config.localActorId };
```

---

## 2.2 新增 Conversation ACL middleware：`server/middleware/conversationAccess.ts`

```ts
import type { NextFunction, Request, Response } from 'express';
import type { TeamService } from '../team-service.js';
import { resolveActor } from './teamScope.js';
import { forbidden } from '../http-error.js';

export function requireConversationAccess(
  team: TeamService,
  paramName = 'id',
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const conversationId = req.params[paramName];
      if (!conversationId) throw forbidden('缺少 conversation id');

      const conversation = team.getConversation(conversationId);
      const actor = resolveActor(req);

      if (actor.kind === 'human') {
        team.requireTeamHumanAccess(conversation.teamId, actor.principalId);
        next();
        return;
      }

      if (!conversation.members.some((m) => m.id === actor.principalId)) {
        throw forbidden('Agent 不属于这个 Conversation');
      }

      next();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 403;
      res.status(status).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
```

---

## 2.3 `server/team-service.ts`

新增：

```ts
requireTeamHumanAccess(teamId: string, principalId: string): void {
  if (!this.structure) {
    throw forbidden('Team structure 未初始化');
  }

  this.structure.requireActiveMembership(
    teamId,
    'human',
    principalId,
  );
}
```

---

## 2.4 `server/app.ts`

增加：

```ts
import { requireHumanAuth } from './middleware/auth.js';
import { requireTeamMember } from './middleware/teamScope.js';
```

所有 Human API：

```ts
const humanApi = [
  requireHumanAuth(),
  requireTeamMember(),
];

app.use('/api/members', ...humanApi, membersRouter(teamService));
app.use('/api/capabilities', ...humanApi, capabilitiesRouter(...));
app.use('/api/knowledge', ...humanApi, knowledgeRouter(...));
app.use('/api/team', ...humanApi, teamRouter(...));
app.use('/api/conversations', ...humanApi, conversationsRouter(...));
app.use('/api/models', ...humanApi, modelsRouter());
app.use('/api/executions', ...humanApi, executionsRouter(teamService));
app.use('/api/tasks', ...humanApi, tasksRouter(teamService));
app.use('/api/mcp', ...humanApi, mcpRouter(mcpServerService));
```

不要给：

```text
/api/health
/api/internal
/api/work-management/jira/webhook
```

加 Human Auth。

---

## 2.5 `server/routes/conversations.ts`

router 初始化后加：

```ts
import { requireConversationAccess } from '../middleware/conversationAccess.js';

router.use('/:id', requireConversationAccess(team, 'id'));
```

这样所有：

```text
GET /:id
GET /:id/messages
POST /:id/messages
GET /:id/tasks
GET /:id/executions
PATCH /:id/goal
POST /:id/members
...
```

统一先做 ACL。

---

## 2.6 senderId 不再写死 local user

`TeamService.sendMessage()` 改成：

```ts
async sendMessage(input: {
  conversationId: string;
  actorId: string;
  content: string;
  replyToMessageId?: string;
  clientRequestId?: string;
  fileIds?: string[];
}): Promise<SendMessageResult> {
```

创建消息时：

```ts
senderId: input.actorId,
```

`server/routes/conversations.ts`：

```ts
import { currentPrincipal } from '../middleware/auth.js';

const principal = currentPrincipal(req);

const result = await team.sendMessage({
  conversationId: req.params.id,
  actorId: principal.principalId,
  ...parsed.data,
});
```

---

## 2.7 Goal 修改同样替换

原来：

```ts
actorId: config.localUserId,
```

改成：

```ts
actorId: currentPrincipal(req).principalId,
```

---

# 3. Member DM 修复

## 3.1 `server/domain.ts`

```ts
export type TurnMode =
  | 'lead'
  | 'mention'
  | 'task'
  | 'delegation'
  | 'member_message';
```

```ts
export type WakeReason =
  | 'lead_bootstrap'
  | 'lead_message'
  | 'lead_clarification'
  | 'lead_recovery'
  | 'goal_changed'
  | 'user_mention'
  | 'member_message'
  | 'task_ready'
  | 'schedule';
```

模型目的：

```ts
export type ModelPurpose =
  | `lead:${LeadModelPurpose}`
  | 'member:mention'
  | 'member:message'
  | 'member:task'
  | 'member:delegation';
```

---

## 3.2 `server/team-service.ts`

`sendMemberMessage()`：

原：

```ts
reason: 'lead_message',
```

改：

```ts
reason: 'member_message',
```

`wakes.push()` 同样改。

---

## 3.3 `runWake()`

原：

```ts
turnMode: task
  ? 'task'
  : wake.reason === 'user_mention'
    ? 'mention'
    : 'lead',
```

改：

```ts
const turnMode: TurnMode =
  task
    ? 'task'
    : wake.reason === 'user_mention'
      ? 'mention'
      : wake.reason === 'member_message'
        ? 'member_message'
        : 'lead';

await this.executeMemberTurn({
  ...
  turnMode,
  wakeReason: wake.reason,
});
```

---

## 3.4 `server/member-turn-scheduler.ts`

增加：

```ts
const REASON_PRIORITY: Record<Exclude<WakeReason, 'schedule'>, number> = {
  goal_changed: 5,
  member_message: 4,
  user_mention: 3,
  task_ready: 2,
  lead_message: 1,
  lead_clarification: 1,
  lead_recovery: 1,
  lead_bootstrap: 0,
};
```

---

# 4. Task Scheduler 丢任务修复

## `server/task-orchestrator.ts`

把 `startReadyTasks()` 改为：

```ts
startReadyTasks(conversationId: string): ConversationTask[] {
  const changed = this.tasks.refreshReady(this.db, conversationId);

  for (const task of changed) {
    this.emit(conversationId, {
      type: 'task.updated',
      data: task,
    });
  }

  const started: ConversationTask[] = [];
  const reservedMembers = new Set<string>();

  for (const task of this.tasks.findReady(conversationId)) {
    const conversation = this.readConversation(conversationId);

    if (!conversation) continue;

    if (task.goalRevision !== conversation.goalRevision) {
      continue;
    }

    // 一个 Member 一次只 reserve 一个 ready Task。
    if (reservedMembers.has(task.assigneeMemberId)) {
      continue;
    }

    // runtime / scheduler 已经有工作时，不覆盖 pending wake。
    if (
      this.hasActiveExecution(
        conversationId,
        task.assigneeMemberId,
      )
    ) {
      continue;
    }

    if (
      this.scheduler.isBusy(
        conversationId,
        task.assigneeMemberId,
      )
    ) {
      continue;
    }

    const state = this.states.get(
      conversationId,
      task.assigneeMemberId,
    );

    if (state.muted) continue;

    this.scheduler.enqueue({
      conversationId,
      memberId: task.assigneeMemberId,
      taskId: task.id,
      reason: 'task_ready',
      triggerSequence: null,
    });

    reservedMembers.add(task.assigneeMemberId);
    started.push(task);
  }

  return started;
}
```

关键点：

```text
一个 Member / 一个 Conversation
同一时间只 reserve 一个 Task
```

Task 完成后：

```ts
this.orchestrator.onTaskChanged(task.id);
```

再次计算 ready queue，第二个 Task 再进来。

---

# 5. `@A @B @C` 不再做隐式串行工作流

不要继续用：

```text
@A -> A 完成 -> @B -> B 完成 -> @C
```

因为 crash / retry / partial completion 很难正确恢复。

## `server/team-service.ts`

`sendMessage()` 中这一段：

```ts
if (mentionedMembers.length > 0) {
  const firstMentioned = ...
  this.scheduler.enqueue(firstMentioned)
}
```

改成：

```ts
if (mentionedMembers.length > 0) {
  for (const member of mentionedMembers) {
    if (this.states.get(conversation.id, member.id).muted) {
      continue;
    }

    this.scheduler.enqueue({
      conversationId: conversation.id,
      memberId: member.id,
      taskId: null,
      reason: 'user_mention',
      triggerSequence: created.messageSequence,
    });

    wakes.push({
      memberId: member.id,
      reason: 'user_mention',
      taskId: null,
      triggerSequence: created.messageSequence,
    });
  }
}
```

删除：

```ts
advanceMentionChain()
```

以及所有：

```ts
advanceMentionChain(...)
```

调用。

如果以后需要严格顺序：

```text
A -> B -> C
```

用：

```text
Task A
Task B dependsOn A
Task C dependsOn B
```

不要用 mention 做 workflow。

---

# 6. Lead-only Tool 防误用

当前 Lead-only tools 已经有：

```ts
availableTo: ['lead']
```

保持。

需要确保新增 `member_message` 后 Resolver 继续过滤：

`server/capabilities/resolver.ts`：

```ts
const visibleTools = dedupedTools.filter((tool) => {
  if (!tool.availableTo || !context.turnMode) return true;
  return tool.availableTo.includes(context.turnMode);
});
```

不要改成「全部可见后靠 prompt 限制」。

必须保留：

```text
可见性 = 第一层
TeamService 的 Lead 检查 = 第二层
Policy = 第三层
```

---

# 7. Data Entitlement

Capability 只回答：

```text
能不能使用 jira_search
```

不能回答：

```text
能看哪些 Jira issue
```

新增：

## `server/entitlement-service.ts`

```ts
import type { DatabaseSync } from 'node:sqlite';

export interface EntitlementContext {
  teamId: string;
  memberId: string;
  providerId: string;
  resourceType: string;
  resourceId: string;
  action: 'read' | 'write';
}

export interface EntitlementDecision {
  allowed: boolean;
  reason: string;
  entitlementId?: string;
  revision: string;
}

export class EntitlementService {
  constructor(private readonly db: DatabaseSync) {}

  revision(): string {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(updated_at), '') AS revision
       FROM data_entitlement`,
    ).get() as { revision: string };

    return row.revision;
  }

  check(input: EntitlementContext): EntitlementDecision {
    const rows = this.db.prepare(
      `
      SELECT id, actions_json
      FROM data_entitlement
      WHERE team_id = ?
        AND provider_id = ?
        AND resource_type = ?
        AND (member_id IS NULL OR member_id = ?)
        AND active = 1
      `,
    ).all(
      input.teamId,
      input.providerId,
      input.resourceType,
      input.memberId,
    ) as Array<{ id: string; actions_json: string }>;

    for (const row of rows) {
      const actions = JSON.parse(row.actions_json) as string[];
      if (actions.includes(input.action)) {
        return {
          allowed: true,
          reason: `entitlement=${row.id}`,
          entitlementId: row.id,
          revision: this.revision(),
        };
      }
    }

    return {
      allowed: false,
      reason:
        `Data Entitlement 拒绝：${input.providerId}/${input.resourceType}/${input.resourceId}`,
      revision: this.revision(),
    };
  }
}
```

---

# 8. DB：Data Entitlement

`server/db-migrations.ts`

把：

```ts
export const SCHEMA_VERSION = 23;
```

改成：

```ts
export const SCHEMA_VERSION = 27;
```

增加：

```sql
CREATE TABLE data_entitlement (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  member_id TEXT,
  provider_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_pattern TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE,

  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_data_entitlement_lookup
  ON data_entitlement(
    team_id,
    member_id,
    provider_id,
    resource_type,
    active
);
```

---

# 9. ToolDecision 增强

## `server/capabilities/types.ts`

```ts
export interface ToolDecision {
  allowed: boolean;
  reason: string;

  policyDecisionId?: string;
  entitlementId?: string;
  policyRevision?: string;
  entitlementRevision?: string;

  approvalRequired?: boolean;
}
```

---

# 10. Tool Policy：Capability → Entitlement → Policy

## `server/tool-policy.ts`

构造函数：

```ts
constructor(
  private readonly options: ToolPolicyOptions,
  private readonly policyService: PolicyService,
  private readonly entitlementService: EntitlementService,
) {}
```

`check()`：

```ts
async check(
  tool: RuntimeTool,
  context: ToolExecutionContext,
  args: Record<string, unknown>,
): Promise<ToolDecision> {
  if (tool.requiresHostAccess && !this.options.allowHostTools) {
    return deny(
      `${tool.name} 需要宿主机能力，但部署层未开启`,
    );
  }

  if (tool.guard) {
    const guardDecision = await tool.guard(context, args);
    if (!guardDecision.allowed) return guardDecision;
  }

  const resource = resolveToolResource(tool, args);

  if (resource) {
    const entitlement =
      this.entitlementService.check({
        teamId: context.teamId,
        memberId: context.memberId,
        providerId: tool.providerId,
        resourceType: resource.type,
        resourceId: resource.id,
        action:
          tool.risk === 'read'
            ? 'read'
            : 'write',
      });

    if (!entitlement.allowed) {
      return {
        allowed: false,
        reason: entitlement.reason,
        entitlementRevision: entitlement.revision,
      };
    }
  }

  if (
    tool.risk === 'external-write' ||
    tool.risk === 'privileged'
  ) {
    return this.policyService.decide({
      tool,
      context,
      args,
    });
  }

  return {
    allowed: true,
    reason: `provider=${tool.providerId}, risk=${tool.risk}`,
    entitlementRevision:
      this.entitlementService.revision(),
  };
}
```

新增：

```ts
function resolveToolResource(
  tool: RuntimeTool,
  args: Record<string, unknown>,
): { type: string; id: string } | null {
  if (tool.providerId === 'atlassian.jira-tools') {
    const issueKey =
      typeof args.issueKey === 'string'
        ? args.issueKey.trim()
        : '';

    if (issueKey) {
      return {
        type: 'jira.issue',
        id: issueKey,
      };
    }

    const jql =
      typeof args.jql === 'string'
        ? args.jql.trim()
        : '';

    if (jql) {
      return {
        type: 'jira.query',
        id: jql,
      };
    }
  }

  return null;
}
```

---

# 11. AuditEvidence

新增：

## `server/audit-service.ts`

```ts
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { now } from './db.js';

export interface ToolExecutionAuditInput {
  executionId: string;
  conversationId: string;
  memberId: string;
  toolName: string;
  providerId: string;
  implementation: string;

  args: Record<string, unknown>;

  allowed: boolean;
  policyDecisionId?: string | null;
  entitlementId?: string | null;

  startedAt?: string;
  endedAt?: string | null;
  result?: unknown;
  error?: string | null;
}

export class AuditService {
  constructor(private readonly db: DatabaseSync) {}

  startToolExecution(input: Omit<
    ToolExecutionAuditInput,
    'endedAt' | 'result' | 'error'
  >): string {
    const id = randomUUID();

    this.db.prepare(
      `
      INSERT INTO tool_execution_audit (
        id,
        execution_id,
        conversation_id,
        member_id,
        tool_name,
        provider_id,
        implementation,
        args_hash,
        args_redacted_json,
        allowed,
        policy_decision_id,
        entitlement_id,
        started_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      input.executionId,
      input.conversationId,
      input.memberId,
      input.toolName,
      input.providerId,
      input.implementation,
      hashJson(input.args),
      JSON.stringify(redactArgs(input.args)),
      input.allowed ? 1 : 0,
      input.policyDecisionId ?? null,
      input.entitlementId ?? null,
      input.startedAt ?? now(),
    );

    return id;
  }

  finishToolExecution(
    auditId: string,
    input: {
      result?: unknown;
      error?: string | null;
    },
  ): void {
    this.db.prepare(
      `
      UPDATE tool_execution_audit
      SET ended_at = ?,
          result_hash = ?,
          error = ?
      WHERE id = ?
      `,
    ).run(
      now(),
      input.result === undefined
        ? null
        : hashJson(input.result),
      input.error ?? null,
      auditId,
    );
  }

  recordPolicyDecision(input: {
    executionId: string;
    toolName: string;
    policyRevision: string;
    decision: 'allow' | 'deny' | 'approval_required';
    reason: string;
    inputHash: string;
  }): string {
    const id = randomUUID();

    this.db.prepare(
      `
      INSERT INTO policy_decision_audit (
        id,
        execution_id,
        tool_name,
        policy_revision,
        decision,
        reason,
        input_hash,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      input.executionId,
      input.toolName,
      input.policyRevision,
      input.decision,
      input.reason,
      input.inputHash,
      now(),
    );

    return id;
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function redactArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const secretNames = new Set([
    'token',
    'apiToken',
    'password',
    'secret',
    'authorization',
    'cookie',
  ]);

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    result[key] = secretNames.has(key.toLowerCase())
      ? '[REDACTED]'
      : value;
  }

  return result;
}
```

---

# 12. DB：Audit

`server/db-migrations.ts`

```sql
CREATE TABLE policy_decision_audit (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (
      decision IN (
        'allow',
        'deny',
        'approval_required'
      )
    ),
  reason TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,

  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_policy_decision_execution
  ON policy_decision_audit(execution_id);

CREATE TABLE tool_execution_audit (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,

  tool_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  implementation TEXT NOT NULL,

  args_hash TEXT NOT NULL,
  args_redacted_json TEXT,

  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),

  policy_decision_id TEXT,
  entitlement_id TEXT,

  started_at TEXT NOT NULL,
  ended_at TEXT,

  result_hash TEXT,
  error TEXT,

  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
    ON DELETE CASCADE,

  FOREIGN KEY (policy_decision_id)
    REFERENCES policy_decision_audit(id)
);

CREATE INDEX idx_tool_execution_audit_execution
  ON tool_execution_audit(execution_id, started_at);
```

---

# 13. Custom Tool 真正执行前后写 Audit

## `server/capabilities/copilot-adapter.ts`

构造函数增加：

```ts
constructor(
  private readonly policy: ToolPolicy,
  private readonly audit?: AuditService,
) {}
```

`defineCustomTool()`：

```ts
handler: async (
  args: unknown,
  _invocation: ToolInvocation,
) => {
  const current: ToolExecutionContext = {
    ...context,
    toolName: tool.name,
  };

  const normalized = normalizeArgs(args);

  const decision = await this.evaluateToolUse(
    tool,
    context,
    normalized,
  );

  const auditId = this.audit?.startToolExecution({
    executionId: context.executionId,
    conversationId: context.conversationId,
    memberId: context.memberId,
    toolName: tool.name,
    providerId: tool.providerId,
    implementation: tool.implementation,
    args: normalized,
    allowed: decision.allowed,
    policyDecisionId: decision.policyDecisionId ?? null,
    entitlementId: decision.entitlementId ?? null,
  });

  if (!decision.allowed) {
    if (auditId) {
      this.audit.finishToolExecution(auditId, {
        error: decision.reason,
      });
    }

    throw new Error(
      `Tool ${tool.name} 被拒绝：${decision.reason}`,
    );
  }

  try {
    const result = await tool.execute!(
      current,
      normalized,
    );

    if (auditId) {
      this.audit.finishToolExecution(auditId, {
        result,
      });
    }

    return result;
  } catch (error) {
    if (auditId) {
      this.audit.finishToolExecution(auditId, {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }

    throw error;
  }
},
```

---

# 14. PolicyDecision 持久化

## `server/policy.ts`

改成：

```ts
import { createHash, randomUUID } from 'node:crypto';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  decisionId?: string;
  policyRevision?: string;
  approvalRequired?: boolean;
}

export interface PolicyService {
  revision(): string;

  decide(
    input: PolicyDecisionInput,
  ): Promise<PolicyDecision> | PolicyDecision;
}

export class DenyHighRiskPolicyService
  implements PolicyService
{
  revision(): string {
    return 'deny-high-risk-v2';
  }

  decide(input: PolicyDecisionInput): PolicyDecision {
    return {
      allowed: false,
      decisionId: randomUUID(),
      policyRevision: this.revision(),
      reason:
        `${input.tool.name}（risk=${input.tool.risk}）` +
        ' 当前必须走独立 Policy/Approval。',
      approvalRequired: true,
    };
  }
}
```

后续真正 Policy Service 只替换这里。

---

# 15. Command Layer

新增：

## `server/command-service.ts`

```ts
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { now } from './db.js';

export type CommandStatus =
  | 'requested'
  | 'policy_pending'
  | 'approved'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface CommandRecord {
  id: string;
  executionId: string;
  conversationId: string;
  memberId: string;

  actorType: 'agent' | 'human';
  actorId: string;

  action: string;
  target: string;

  argsHash: string;
  idempotencyKey: string;

  resourceVersion: string | null;

  policyDecisionId: string | null;
  approvalId: string | null;

  status: CommandStatus;

  createdAt: string;
  executedAt: string | null;
  resultHash: string | null;
}

export class CommandService {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    executionId: string;
    conversationId: string;
    memberId: string;
    actorType: 'agent' | 'human';
    actorId: string;
    action: string;
    target: string;
    argsHash: string;
    idempotencyKey: string;
    resourceVersion?: string | null;
    policyDecisionId?: string | null;
    approvalId?: string | null;
  }): CommandRecord {
    const existing = this.db.prepare(
      `SELECT * FROM command
       WHERE idempotency_key = ?`,
    ).get(input.idempotencyKey);

    if (existing) {
      return mapCommand(existing as Record<string, unknown>);
    }

    const record: CommandRecord = {
      id: randomUUID(),
      executionId: input.executionId,
      conversationId: input.conversationId,
      memberId: input.memberId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      target: input.target,
      argsHash: input.argsHash,
      idempotencyKey: input.idempotencyKey,
      resourceVersion: input.resourceVersion ?? null,
      policyDecisionId: input.policyDecisionId ?? null,
      approvalId: input.approvalId ?? null,
      status:
        input.approvalId
          ? 'approved'
          : 'ready',
      createdAt: now(),
      executedAt: null,
      resultHash: null,
    };

    this.db.prepare(
      `
      INSERT INTO command (
        id,
        execution_id,
        conversation_id,
        member_id,
        actor_type,
        actor_id,
        action,
        target,
        args_hash,
        idempotency_key,
        resource_version,
        policy_decision_id,
        approval_id,
        status,
        created_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      `,
    ).run(
      record.id,
      record.executionId,
      record.conversationId,
      record.memberId,
      record.actorType,
      record.actorId,
      record.action,
      record.target,
      record.argsHash,
      record.idempotencyKey,
      record.resourceVersion,
      record.policyDecisionId,
      record.approvalId,
      record.status,
      record.createdAt,
    );

    return record;
  }

  markExecuting(commandId: string): void {
    this.db.prepare(
      `UPDATE command
       SET status = 'executing'
       WHERE id = ? AND status IN ('approved', 'ready')`,
    ).run(commandId);
  }

  markCompleted(
    commandId: string,
    resultHash: string,
  ): void {
    this.db.prepare(
      `
      UPDATE command
      SET status = 'completed',
          executed_at = ?,
          result_hash = ?
      WHERE id = ?
      `,
    ).run(now(), resultHash, commandId);
  }

  markFailed(commandId: string): void {
    this.db.prepare(
      `UPDATE command
       SET status = 'failed',
           executed_at = ?
       WHERE id = ?`,
    ).run(now(), commandId);
  }
}

function mapCommand(row: Record<string, unknown>): CommandRecord {
  return {
    id: String(row.id),
    executionId: String(row.execution_id),
    conversationId: String(row.conversation_id),
    memberId: String(row.member_id),
    actorType: row.actor_type as 'agent' | 'human',
    actorId: String(row.actor_id),
    action: String(row.action),
    target: String(row.target),
    argsHash: String(row.args_hash),
    idempotencyKey: String(row.idempotency_key),
    resourceVersion:
      row.resource_version == null
        ? null
        : String(row.resource_version),
    policyDecisionId:
      row.policy_decision_id == null
        ? null
        : String(row.policy_decision_id),
    approvalId:
      row.approval_id == null
        ? null
        : String(row.approval_id),
    status: row.status as CommandStatus,
    createdAt: String(row.created_at),
    executedAt:
      row.executed_at == null
        ? null
        : String(row.executed_at),
    resultHash:
      row.result_hash == null
        ? null
        : String(row.result_hash),
  };
}
```

---

# 16. DB：Command / Approval

```sql
CREATE TABLE command (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,

  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('agent', 'human')),
  actor_id TEXT NOT NULL,

  action TEXT NOT NULL,
  target TEXT NOT NULL,

  args_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,

  resource_version TEXT,

  policy_decision_id TEXT,
  approval_id TEXT,

  status TEXT NOT NULL
    CHECK (
      status IN (
        'requested',
        'policy_pending',
        'approved',
        'ready',
        'executing',
        'completed',
        'failed',
        'rejected',
        'cancelled',
        'expired'
      )
    ),

  created_at TEXT NOT NULL,
  executed_at TEXT,
  result_hash TEXT,

  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
    ON DELETE CASCADE,

  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,

  FOREIGN KEY (member_id)
    REFERENCES member(id)
);

CREATE INDEX idx_command_execution
  ON command(execution_id, created_at);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (
      decision IN (
        'pending',
        'approved',
        'rejected',
        'expired'
      )
    ),
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,

  FOREIGN KEY (command_id)
    REFERENCES command(id)
    ON DELETE CASCADE
);
```

---

# 17. Jira Write 改 Command

## `server/capabilities/providers/jira-tools.ts`

`jira_add_comment` 和 `jira_transition_issue` 的 `execute()` 不再直接：

```ts
await this.work.addComment(...)
```

改成：

```ts
const command = await this.command.request({
  executionId: context.executionId,
  conversationId: context.conversationId,
  memberId: context.memberId,
  actorType: 'agent',
  actorId: context.memberId,

  action: 'jira.add_comment',
  target: ref.key,

  args: {
    issueKey: ref.key,
    body: String(args.body),
  },

  idempotencyKey:
    `${context.executionId}:jira.add_comment:${ref.key}`,
});

return command.result;
```

CommandService 内部：

```text
Entitlement
  -> Policy
     -> Approval(optional)
        -> Command
           -> JiraProvider
```

禁止：

```text
Agent -> Jira REST
```

---

# 18. Jira TOCTOU

`server/work-management/jira-provider.ts`

新增条件接口：

```ts
interface ExternalResourceVersion {
  version: string;
}

async addCommentIfVersion(
  ref: ExternalWorkRef,
  body: string,
  expectedVersion: string,
): Promise<void> {
  const current = await this.client.getIssue(ref.key);

  if (current.version !== expectedVersion) {
    throw new Error(
      `Jira issue ${ref.key} 已变化，拒绝执行旧 Command`,
    );
  }

  await this.client.addComment(ref.key, body);
}
```

Jira client 同步：

```ts
getIssue()
```

必须返回：

```ts
version
```

不能只返回：

```text
status / assignee / summary
```

---

# 19. ExecutionConfigSnapshot 不能只有 hash

## `server/domain.ts`

改：

```ts
export interface ExecutionConfigSnapshot {
  memberRevision: string;

  model: string;
  modelPurpose?: ModelPurpose;

  systemPromptHash: string;
  memoryHash: string;
  capabilityManifestHash: string;

  hostToolsEnabled: boolean;
  policyRevision?: string;

  entitlementRevision?: string;

  effectiveConfig?: {
    memberId: string;
    teamId: string;
    toolNames: string[];
    skillNames: string[];
    knowledgeNames: string[];
    mcpServers: string[];
    turnMode: TurnMode;
    policyRevision?: string;
    entitlementRevision?: string;
  };

  canonicalHash?: string;
}
```

保存时：

```ts
const effectiveConfig = {
  memberId: member.id,
  teamId: conversation.teamId,
  toolNames: capabilities.tools.map((x) => x.name).sort(),
  skillNames: capabilities.skills.map((x) => x.name).sort(),
  knowledgeNames: capabilities.knowledge.map((x) => x.name).sort(),
  mcpServers: capabilities.mcpServers.map((x) => x.id).sort(),
  turnMode,
  policyRevision,
  entitlementRevision,
};

const canonicalHash = createHash('sha256')
  .update(JSON.stringify(effectiveConfig))
  .digest('hex');
```

数据库保存：

```json
{
  "effectiveConfig": {},
  "canonicalHash": "..."
}
```

这样才是：

```text
hash + actual evidence
```

而不是：

```text
hash only
```

---

# 20. Experience Governance

## `server/experience-store.ts`

Record 增加：

```ts
export interface ExperienceRecord {
  id: string;
  memberId: string;
  teamId: string;

  kind: ExperienceKind;

  trigger: string;
  lesson: string;
  evidence?: string | null;

  scope: 'member' | 'team';

  reviewStatus: 'approved' | 'pending';

  sourceExecutionId: string | null;

  createdByMemberId: string;

  approvedBy: string | null;
  approvedAt: string | null;

  confidence: number;

  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
}
```

`add()`：

```ts
const scope = input.scope ?? 'member';

const record: ExperienceRecord = {
  ...
  scope,

  reviewStatus:
    scope === 'team'
      ? 'pending'
      : 'approved',

  sourceExecutionId:
    input.sourceExecutionId ?? null,

  createdByMemberId: input.memberId,

  approvedBy:
    scope === 'team'
      ? null
      : input.memberId,

  approvedAt:
    scope === 'team'
      ? null
      : new Date().toISOString(),
};
```

搜索：

```ts
.filter((item) => {
  if (item.scope === 'member') {
    return item.memberId === input.memberId;
  }

  return (
    item.scope === 'team' &&
    item.reviewStatus === 'approved'
  );
})
```

---

## `TeamService.learnExperience()`

改：

```ts
const scope = input.scope ?? 'member';

const experience = this.experiences.add({
  ...
  scope,
  sourceExecutionId:
    input.executionId ?? null,
});
```

---

## `core-tools.ts`

把：

```ts
scope: z.enum(['member', 'team']).default('team'),
```

改：

```ts
scope: z.enum(['member', 'team']).default('member'),
```

描述增加：

```text
team scope 仅创建待审核候选；未经审核不能被其他 Member 检索。
```

---

# 21. Team Experience Approval API

新增：

```text
POST /api/team/experiences/:id/approve
POST /api/team/experiences/:id/reject
```

只允许：

```text
owner/admin
```

服务：

```ts
approveTeamExperience(
  teamId: string,
  experienceId: string,
  approver: string,
): ExperienceRecord {
  return this.experiences.approveTeam(
    teamId,
    experienceId,
    approver,
  );
}
```

---

# 22. MCP Secret 从 SQLite 移出

当前：

```text
mcp_server.headers_json
mcp_server.env_json
```

不要再保存真实 credential。

增加：

```sql
ALTER 逻辑替换为：

secret_ref TEXT
```

最终：

```sql
CREATE TABLE mcp_server (
  ...
  secret_ref TEXT,
  ...
);
```

`headers_json` / `env_json` 只允许非敏感配置。

---

## `server/mcp/service.ts`

输入：

```ts
secretRef?: string;
```

而不是：

```ts
secret?: string;
```

生产读取：

```ts
export interface SecretProvider {
  get(ref: string): Promise<Record<string, string>>;
}
```

例如：

```ts
class EnvSecretProvider implements SecretProvider {
  async get(ref: string) {
    const raw = process.env[ref];

    if (!raw) {
      throw new Error(
        `Secret ${ref} 未配置`,
      );
    }

    return JSON.parse(raw) as Record<string, string>;
  }
}
```

生产实现替换为：

```text
AWS Secrets Manager
Azure Key Vault
Kubernetes Secret + external secret operator
```

数据库只留：

```text
secret_ref = "prod/jira/copilot"
```

---

# 23. Multi-process Worker Lease

当前：

```text
pending Map
inFlight Set
runtime locks
```

都只能支持单进程。

先增加 DB lease。

## `server/db-migrations.ts`

```sql
CREATE TABLE worker_lease (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,

  lease_owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,

  PRIMARY KEY (
    resource_type,
    resource_id
  )
);
```

---

## `server/worker-lease.ts`

```ts
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { now } from './db.js';

export class WorkerLeaseService {
  readonly owner = randomUUID();

  constructor(
    private readonly db: DatabaseSync,
    private readonly ttlMs = 30_000,
  ) {}

  claim(
    resourceType: string,
    resourceId: string,
  ): boolean {
    const current = Date.now();
    const expires = new Date(
      current + this.ttlMs,
    ).toISOString();

    const result = this.db.prepare(
      `
      INSERT INTO worker_lease (
        resource_type,
        resource_id,
        lease_owner,
        lease_expires_at,
        heartbeat_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resource_type, resource_id)
      DO UPDATE SET
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        heartbeat_at = excluded.heartbeat_at
      WHERE worker_lease.lease_expires_at < ?
      `,
    ).run(
      resourceType,
      resourceId,
      this.owner,
      expires,
      now(),
      now(),
    );

    return Number(result.changes) === 1;
  }

  heartbeat(
    resourceType: string,
    resourceId: string,
  ): void {
    this.db.prepare(
      `
      UPDATE worker_lease
      SET lease_expires_at = ?,
          heartbeat_at = ?
      WHERE resource_type = ?
        AND resource_id = ?
        AND lease_owner = ?
      `,
    ).run(
      new Date(
        Date.now() + this.ttlMs,
      ).toISOString(),
      now(),
      resourceType,
      resourceId,
      this.owner,
    );
  }

  release(
    resourceType: string,
    resourceId: string,
  ): void {
    this.db.prepare(
      `
      DELETE FROM worker_lease
      WHERE resource_type = ?
        AND resource_id = ?
        AND lease_owner = ?
      `,
    ).run(
      resourceType,
      resourceId,
      this.owner,
    );
  }
}
```

---

# 24. RecoveryService

不要再：

```sql
UPDATE execution
SET status='interrupted'
WHERE status IN ('running', ...)
```

直接全部打掉。

改为：

```sql
UPDATE execution
SET status='interrupted'
WHERE status IN ('running', 'waiting_for_member')
  AND id IN (
    SELECT resource_id
    FROM worker_lease
    WHERE resource_type = 'execution'
      AND lease_expires_at < ?
  );
```

同理：

```text
runtime
scheduler job
conversation member wake
```

都只能 reclaim：

```text
expired lease
```

不能看到 running 就直接抢。

---

# 25. SchedulerService

worker loop：

```ts
for (;;) {
  const candidates = repository.findRunnable();

  for (const item of candidates) {
    if (
      !lease.claim(
        'execution',
        item.executionId,
      )
    ) {
      continue;
    }

    void runExecution(item)
      .finally(() => {
        lease.release(
          'execution',
          item.executionId,
        );
      });
  }

  await sleep(config.schedulerIntervalMs);
}
```

执行中定期：

```ts
lease.heartbeat(
  'execution',
  execution.id,
);
```

---

# 26. 单进程前先加启动保护

`server/index.ts`：

```ts
if (
  config.recoverOnStartup &&
  config.workerReplicas > 1 &&
  !config.workerLeaseEnabled
) {
  throw new Error(
    'WORKER_REPLICAS > 1 时必须启用 WORKER_LEASE',
  );
}
```

`server/config.ts`：

```ts
workerReplicas: intEnv('WORKER_REPLICAS', 1),
workerLeaseEnabled:
  env('WORKER_LEASE_ENABLED', 'false') === 'true',
workerId:
  env('WORKER_ID', ''),
```

---

# 27. `ExecutionConfigSnapshot` + Policy + Entitlement

`TeamService.buildConfigSnapshot()` 最终必须产生：

```json
{
  "memberRevision": "...",
  "model": "...",
  "modelPurpose": "member:task",
  "systemPromptHash": "...",
  "memoryHash": "...",
  "capabilityManifestHash": "...",
  "hostToolsEnabled": false,
  "policyRevision": "deny-high-risk-v2",
  "entitlementRevision": "...",

  "effectiveConfig": {
    "memberId": "...",
    "teamId": "...",
    "turnMode": "task",
    "toolNames": [],
    "skillNames": [],
    "knowledgeNames": [],
    "mcpServers": []
  },

  "canonicalHash": "..."
}
```

---

# 28. Budget

增加 `server/budget-service.ts`：

```ts
export interface BudgetLimit {
  maxDurationMs: number;
  maxToolCalls: number;
  maxDelegationDepth: number;
  maxChildExecutions: number;
}

export interface BudgetUsage {
  durationMs: number;
  toolCalls: number;
  delegationDepth: number;
  childExecutions: number;
}

export class BudgetService {
  constructor(
    private readonly limit: BudgetLimit,
  ) {}

  check(
    usage: BudgetUsage,
  ): { allowed: boolean; reason: string } {
    if (
      usage.durationMs >
      this.limit.maxDurationMs
    ) {
      return {
        allowed: false,
        reason: 'execution duration budget exceeded',
      };
    }

    if (
      usage.toolCalls >
      this.limit.maxToolCalls
    ) {
      return {
        allowed: false,
        reason: 'tool call budget exceeded',
      };
    }

    if (
      usage.delegationDepth >
      this.limit.maxDelegationDepth
    ) {
      return {
        allowed: false,
        reason: 'delegation depth budget exceeded',
      };
    }

    if (
      usage.childExecutions >
      this.limit.maxChildExecutions
    ) {
      return {
        allowed: false,
        reason: 'child execution budget exceeded',
      };
    }

    return {
      allowed: true,
      reason: 'within budget',
    };
  }
}
```

第一阶段只接：

```text
execution
tool calls
delegation depth
child executions
```

token/cost 后接 LiteLLM usage。

---

# 29. `notifyMcpToolUse()` 不再作为 Audit

保留它给 UI：

```ts
this.options.onMcpToolUse?.(...)
```

但是新增：

```ts
audit.startToolExecution(...)
audit.finishToolExecution(...)
```

所以：

```text
ConversationEvent / TeamEvent
= UI / SSE / replay

AuditEvidence
= compliance / regulatory evidence
```

两者不要再互相替代。

---

# 30. `onPermissionRequest`

## `server/copilot.ts`

当前：

```ts
return { kind: 'user-not-available' };
```

暂时保持拒绝。

但将来必须变为：

```text
Permission Request
    ↓
Policy
    ↓
Approval
    ↓
Human
    ↓
Approval Decision
```

不要：

```text
permission request -> allow
```

也不要把：

```text
onPermissionRequest
```

当完整 Policy Service。

---

# 31. TeamService 拆分

当前 `server/team-service.ts` 约 170KB。

不要一次大重构。

先拆 4 个：

```text
server/conversation-service.ts
server/task-application-service.ts
server/execution-service.ts
server/collaboration-service.ts
```

第一步只移动方法，不改变 DB schema：

### `conversation-service.ts`

移动：

```text
getConversation
listConversations
createConversation
addMember
removeMember
sendMessage
listMessages
listConversationState
setMemberMuted
updateGoal
listGoalRevisions
```

### `task-application-service.ts`

移动：

```text
getTask
listTasks
planTasks
addTask
replanTasks
retryTask
cancelTask
updateTask
reassignTask
```

### `execution-service.ts`

移动：

```text
getExecution
listExecutions
retryExecution
cancelExecution
runWake
executeMemberTurn
buildConfigSnapshot
```

### `collaboration-service.ts`

移动：

```text
delegateMember
messageMember
sendDirectMessage
requestClarification
learnExperience
rememberMember
```

`TeamService` 最终只保留 facade。

---

# 32. 删除 lead_bootstrap 的后续处理

现在先不删除。

后续 UI 不需要 Agent 自动开场时：

`server/routes/conversations.ts`

```ts
team.createConversation(
  parsed.data,
  { autoStartLead: false },
)
```

然后真正收到：

```text
POST /conversations/:id/messages
```

才 wake Lead。

这样可以彻底删除：

```text
cancelLeadBootstrap()
lead_bootstrap wake
bootstrap cancellation race
```

建议放到第二批。

---

# 33. 必加测试

## `server/test/member-dm.test.ts`

至少：

```ts
it(
  'member DM uses member_message turn mode',
  async () => {
    const result =
      await team.sendDirectMessage({
        fromMemberId: alice.id,
        toMemberId: bob.id,
        content: 'hello',
      });

    await scheduler.drain();

    const executions =
      team.listExecutions(
        result.conversation.id,
      );

    assert.equal(
      executions[0].wakeReason,
      'member_message',
    );
  },
);
```

---

## `server/test/task-orchestrator.test.ts`

```ts
it(
  'only one ready task per member is reserved',
  () => {
    const started =
      orchestrator.startReadyTasks(
        conversation.id,
      );

    assert.equal(
      started.filter(
        (task) =>
          task.assigneeMemberId === member.id,
      ).length,
      1,
    );
  },
);
```

---

## `server/test/mentions.test.ts`

```ts
it(
  '@A @B @C creates three independent wakes',
  async () => {
    const result =
      await team.sendMessage({
        conversationId: conversation.id,
        actorId: userId,
        content: '@A @B @C 请分析',
      });

    assert.equal(result.wakes.length, 3);

    assert.deepEqual(
      result.wakes.map((x) => x.memberId),
      [alice.id, bob.id, charlie.id],
    );
  },
);
```

---

## `server/test/auth.test.ts`

必须测试：

```text
没有 Bearer -> 401
错误 issuer -> 401
错误 audience -> 401
合法 JWT -> 通过
inactive Team member -> 403
非 Team 成员 -> 403
conversation 不属于该 Team -> 403
Agent 不属于 conversation -> 403
```

---

## `server/test/audit.test.ts`

必须测试：

```text
tool deny -> 有 audit
tool allow -> 有 audit
tool throws -> 有 audit + error
policy deny -> 有 policy_decision
entitlement deny -> 有 entitlement decision
```

---

## `server/test/recovery-lease.test.ts`

必须测试：

```text
worker A lease 未过期
worker B 不能 claim

worker A lease 过期
worker B 可以 claim

worker A heartbeat 后
worker B 不能抢

release 后
worker B 可以 claim
```

---

# 34. 最终运行时结构

```text
Human
  │
  ▼
OIDC/JWT
  │
  ▼
Principal
  │
  ▼
Team Membership
  │
  ▼
Conversation ACL
  │
  ▼
Goal / Task / Execution
  │
  ▼
Scheduler + Worker Lease
  │
  ▼
Member Runtime
  │
  ▼
Capability
  │
  ├── Skill
  ├── Knowledge
  ├── Tool
  └── MCP
        │
        ▼
Data Entitlement
        │
        ▼
Policy
        │
        ▼
Command
        │
        ├── Approval
        │
        ▼
Executor
        │
        ▼
External System
```

审计链：

```text
Human/Agent
   ↓
Execution
   ↓
ToolExecution
   ↓
PolicyDecision
   ↓
Command
   ↓
Approval
   ↓
External Effect
```

---

# 35. 实施顺序

不要一次全部上线。

## 第 1 批

```text
1. OIDC/JWT
2. Team/Conversation ACL
3. member_message
4. task scheduler serialization
5. @mention parallel
6. Experience member-default
```

## 第 2 批

```text
7. AuditService
8. PolicyDecision
9. Data Entitlement
10. Config Snapshot evidence
11. MCP Secret Ref
```

## 第 3 批

```text
12. CommandService
13. Approval
14. Jira conditional execution
15. Budget
```

## 第 4 批

```text
16. Worker Lease
17. durable scheduler
18. Recovery lease reclaim
19. multi-replica deployment
```

## 第 5 批

```text
20. TeamService 拆分
21. 删除 lead_bootstrap
22. evaluation / regression suite
```

---

# 36. 不要做

当前版本不要加入：

```text
Temporal
BPMN
通用 workflow engine
Agent 自己决定 authorization
LLM 自己决定 Policy
Skill 文本充当 security boundary
MCP token 直接下发给 Agent
ConversationEvent 当 regulatory audit
```

核心原则固定为：

```text
LLM 可以推理
但不能定义授权边界。

Capability = 能使用什么服务
Entitlement = 能访问什么数据
Policy = 当前动作是否允许
Approval = 是否需要人批准
Command = 真正要执行的业务动作
AuditEvidence = 事后证明发生了什么
```
