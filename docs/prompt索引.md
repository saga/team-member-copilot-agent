# Prompt 索引

> 收录标准：进模型的指令文本（system prompt、turn instruction、tool description、服务端生成的触发消息）。
> 不单列：`MEMORY.md` / 团队上下文 / 知识库正文 / 会话附件——它们是数据，由 work contract 组装器注入；
> Scheduler 里用户手写的 prompt 是运行时输入，不是代码。

## 一、Member Identity & Work Contract

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| Member Work Contract 组装器 | `server/execution-service.ts`（`buildMemberSystemPrompt`） | 把身份、角色、工作契约、授权规则、房间成员、知识源清单、长期记忆 + Team 上下文拼成每轮的 system prompt |
| Security Reviewer Work Contract | `config/member-templates/financial-security-reviewer/SYSTEM_PROMPT.md` | 独立安全评审工作契约：只发现风险、不做最终审批、不授予权限，先独立分析再看他人结论 |
| Senior Software Engineer Work Contract | `config/member-templates/financial-senior-engineer/SYSTEM_PROMPT.md` | 实现工人工作契约：把架构和需求转成可靠可测的实现，附带输出契约 |
| Solution Architect Work Contract | `config/member-templates/financial-solution-architect/SYSTEM_PROMPT.md` | 架构规划工人工作契约：业务需求转可落地、可被工程实现、可被安全评审的方案，附带输出契约 |

## 二、工作模式指令（每轮 user prompt 尾部）

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| LEAD_INSTRUCTION | `server/context-assembler.ts` | Lead 工作手册：Single-Agent-first 路由、需求 intake、Jira 先审后规划、只 plan 一次（增量用 add/reassign）、Jira subtask 不自动复制、只推进不闲聊 |
| TASK_INSTRUCTION | `server/context-assembler.ts` | Task 执行人工作手册：埋头干活、用 update_task 报告完成或阻塞、不说废话 |
| User prompt 组装器 | `server/context-assembler.ts`（`buildPrompt`） | 把 work item 引用、workspace 头、附件清单、消息转录、当前任务/消息按顺序拼成一轮的 user prompt；independentContext 的 Task 与 delegation 不注入共享房间记录 |
| Task independent context | `server/context-assembler.ts`（`buildPrompt` 内） | independentContext Task 与 delegation 只拿任务包，不读共享 transcript；水位线也不推进 |
| Mention independence | `server/context-assembler.ts` | 被 @ 的 Member 独立回答，不读前序 Member 结论，不被锚定 |
| Single-Agent-first routing | `server/context-assembler.ts`（LEAD_INSTRUCTION 内） | 默认一个强 worker；多人只在并行/独立审查/边界不同时启用 |

## 三、协作工具描述（模型可见的英文说明，决定模型何时调什么）

`server/capabilities/providers/core-tools.ts`：

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| ask_member | `server/capabilities/providers/core-tools.ts` | 委派给职责/能力/知识/工具显著不同的 specialized worker（阻塞等结果）；能自己干完的不委派，不要只为要个意见 |
| message_member | `server/capabilities/providers/core-tools.ts` | 给其他成员发私聊消息（发完即返，不等回复） |
| remember_member | `server/capabilities/providers/core-tools.ts` | 往当前 Team 上下文记长期事实/习惯，不进全局记忆 |
| request_clarification | `server/capabilities/providers/core-tools.ts` | 缺关键信息时向用户要答案（一次最多 3 个），工作区进 waiting_user |
| plan_tasks | `server/capabilities/providers/core-tools.ts` | 初始任务规划专用（已有任务后禁用，增量走 add/reassign），可指定任务模型档位 |
| add_task | `server/capabilities/providers/core-tools.ts` | 给已有计划补一个真正缺失的任务，不复制已有任务或 Jira subtask |
| reassign_task | `server/capabilities/providers/core-tools.ts` | 给没跑起来的任务换执行人（ready/running/completed/cancelled 不许换） |
| update_task | `server/capabilities/providers/core-tools.ts` | 执行人上报进展：做完报 completed，卡住报 blocked，不许只用文字糊弄 |

`server/capabilities/providers/knowledge-tools.ts`：

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| search_knowledge | `server/capabilities/providers/knowledge-tools.ts` | 跨团队库和个人库检索公司特有资料，优先于模型通用知识 |
| open_knowledge_document | `server/capabilities/providers/knowledge-tools.ts` | 片段不够时打开整份知识文档，需按 hit 里原样回传 providerId 以便路由 |

`server/capabilities/providers/conversation-file-tools.ts`：

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| search_conversation_files | `server/capabilities/providers/conversation-file-tools.ts` | 只搜本房间共享文件（不碰知识库），找“刚才那份文档说了什么” |
| open_conversation_file | `server/capabilities/providers/conversation-file-tools.ts` | 按 fileId 打开房间文件的索引文本 |

`server/capabilities/providers/jira-tools.ts`：

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| jira_search | `server/capabilities/providers/jira-tools.ts` | JQL 搜工单（含 description 和 subtask 查询如 `parent = ABC-123`） |
| jira_get_issue | `server/capabilities/providers/jira-tools.ts` | 按 key 读单张工单的摘要、描述、状态、负责人和链接 |
| jira_add_comment | `server/capabilities/providers/jira-tools.ts` | 给工单加评论（external-write，走 Policy 审批） |
| jira_transition_issue | `server/capabilities/providers/jira-tools.ts` | 推工单走工作流（external-write，transition 须在 Jira 侧合法） |

`server/capabilities/providers/host-tools.ts`：

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| bash | `server/capabilities/providers/host-tools.ts` | 跑 shell 命令（触达宿主机，需部署开关放行） |
| edit | `server/capabilities/providers/host-tools.ts` | 改文件（触达宿主机，需部署开关放行） |
| grep | `server/capabilities/providers/host-tools.ts` | 搜文件内容 |
| web_fetch | `server/capabilities/providers/host-tools.ts` | 抓网页内容（外部读取） |

## 四、服务端生成的触发消息（进上下文的消息，不是用户发的）

| Prompt 名称 | 文件名 | 目的（summary） |
|---|---|---|
| 新工作区开场白 | `server/team-service.ts`（`createConversation`） | 建工作区时落一条 system 消息（标题、参与人、挂钩业务），触发 Lead 首轮主动推进 |
| Delegation 任务信封 | `server/team-service.ts`（`delegateMember`） | `ask_member` 发给目标成员的任务包：谁派的 + 任务 + 原因，要求返回简明结果 |
