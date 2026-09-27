"""变异验证：把关键实现改回错误写法，确认对应的断言真的变红。

每个变异只改一处，跑一个定向测试文件，断言它失败，然后按内存里的原文还原
（不走 git —— 这些文件里可能有尚未提交的改动）。开跑之前先做一次基线预检：
测试文件本身就是红的就直接停，否则「上一次被中断留下的变异」会被误读成锚点写错。

**超时算「捕获」**：有些变异会把系统推进死循环（例如拿掉唤醒合并，
同一条唤醒被反复重派），测试不会红，而是一直跑下去。挂死也是一种失败 ——
而且是比断言失败更严重的失败，所以这里给它一个上限，超时即判定断言有区分度。
顺带这也是还原逻辑的保护：没有超时的话，杀掉脚本会留下一个被改过的源文件。
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 单个测试文件的上限。正常一次 1~3 秒，给足余量；超过就是挂住了。
TEST_TIMEOUT_SECONDS = 60


def run_test(rel_path: str) -> bool:
    """跑一个测试文件，返回它是否通过。超时视为不通过（= 变异被捕获）。"""
    try:
        result = subprocess.run(
            ["node", "--import", "tsx", "--test", rel_path],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        print(f"      （测试超过 {TEST_TIMEOUT_SECONDS}s 未结束 —— 变异把系统推成了死循环）")
        return False
    # Node 24 的 test runner 输出 `ℹ fail 0`，旧版输出 `# fail 0` —— 两种都认。
    return (
        ("# fail 0" in result.stdout or "ℹ fail 0" in result.stdout)
        and result.returncode == 0
    )


MUTATIONS = [
    {
        "name": "空 selector 落成 NULL（主键唯一性会失效）",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            ("server/capabilities/service.ts", "binding.selector ?? '',", "binding.selector || null,")
        ],
    },
    {
        "name": "replace 不推进 member.updated_at",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/service.ts",
                "      this.db\n        .prepare(`UPDATE member SET updated_at = ? WHERE id = ?`)\n        .run(timestamp, memberId);\n",
                "",
            )
        ],
    },
    {
        "name": "manifest 对 skill 不做排序（binding 顺序变了哈希就变）",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/resolver.ts",
                "    skills: [...skills]\n      .sort(byKey((entry) => `${entry.providerId}\\u0000${entry.artifact.name}`))\n      .map((entry) => ({",
                "    skills: [...skills]\n      .map((entry) => ({",
            )
        ],
    },
    {
        "name": "manifest 不记 Provider 版本",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            ("server/capabilities/resolver.ts", "        providerVersion: entry.providerVersion,\n", "")
        ],
    },
    {
        "name": "personal KB 不查属主（只看 binding）",
        "test": "server/test/knowledge-provider.test.ts",
        "steps": [
            (
                "server/capabilities/providers/filesystem-knowledge.ts",
                "    if (kb.scope === 'personal' && kb.memberId !== memberId) {\n      throw forbidden('这是别人的个人资料库，没有权限查看');\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "检索不限定在已授权的 KB 上",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/providers/filesystem-knowledge.ts",
                "        WHERE knowledge_document_fts MATCH ?\n          AND d.knowledge_base_id = ?\n",
                "        WHERE knowledge_document_fts MATCH ?\n",
            )
        ],
    },
    {
        "name": "扫目录不判格式 / 大小（什么文件都索引）",
        "test": "server/test/knowledge-provider.test.ts",
        "steps": [
            (
                "server/capabilities/providers/filesystem-knowledge.ts",
                "        const issue = documentPathIssue(relativePath, fs.statSync(full).size);\n        if (issue) {\n          warnSkip(`${kb.key}/${relativePath}`, new Error(issue));\n          continue;\n        }\n",
                "",
            )
        ],
    },
    {
        "name": "写文档时不判格式 / 大小（API 与扫目录不一致）",
        "test": "server/test/knowledge-provider.test.ts",
        "steps": [
            (
                "server/capabilities/providers/filesystem-knowledge.ts",
                "    const issue = documentPathIssue(relativePath, Buffer.byteLength(input.content, 'utf8'));\n    if (issue) throw badRequest(`不写入这份文档：${issue}`);\n",
                "",
            )
        ],
    },
    {
        "name": "被部署收走的宿主工具照样声明给引擎",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            ("server/capabilities/copilot-adapter.ts", "      if (this.policy.hostToolWithheld(tool)) continue;\n", "")
        ],
    },
    {
        "name": "open 失败时不优先抛 403（先到的错误赢）",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/providers/knowledge-tools.ts",
                "            failures.find((error) => statusOf(error) === 403) ??\n            failures[0] ??",
                "            failures[0] ??",
            )
        ],
    },
    {
        "name": "模板能力改成先建人、后校验",
        "test": "server/test/member-template-seeder.test.ts",
        "steps": [
            (
                "server/member-template-seeder.ts",
                "    const memberCapabilities: MemberCapabilities = template.capabilities;\n    resolver.validate(memberCapabilities);\n\n    const member = memberService.create(",
                "    const memberCapabilities: MemberCapabilities = template.capabilities;\n\n    const member = memberService.create(",
            ),
            (
                "server/member-template-seeder.ts",
                "    capabilities.replaceMember(member.id, memberCapabilities);\n",
                "    capabilities.replaceMember(member.id, memberCapabilities);\n    resolver.validate(memberCapabilities);\n",
            ),
        ],
    },
    {
        "name": "模板能力完全不校验",
        "test": "server/test/member-template-seeder.test.ts",
        "steps": [
            ("server/member-template-seeder.ts", "    resolver.validate(memberCapabilities);\n", "")
        ],
    },
    {
        "name": "删掉 schedule 幂等 UNIQUE（同一时间点执行两遍）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/db-migrations.ts",
                "  UNIQUE (schedule_id, scheduled_for),\n",
                "",
            )
        ],
    },
    {
        "name": "paused 成员仍执行 schedule（自动唤醒不看 presence）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/scheduler-service.ts",
                "        if (presence.availability === 'paused') continue;\n",
                "",
            )
        ],
    },
    {
        "name": "scheduled run 不随 execution 收口（run 永远停在 running）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "    } finally {\n      this.settleScheduleRun(executionId);\n    }",
                "    }",
            )
        ],
    },
    {
        "name": "恢复时 completed 的 execution 不收口 run",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/scheduler-service.ts",
                "        if (execution.status === 'completed') {\n          this.structure.updateScheduleRun(run.id, { status: 'completed' });\n          continue;\n        }",
                "        if (execution.status === 'completed') {\n          continue;\n        }",
            )
        ],
    },
    {
        "name": "createSchedule 不查 Member 是否在 conversation 里",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-structure-service.ts",
                "    if (!memberInConversation) {\n      throw badRequest('定时任务的执行成员必须在这个 Task 工作区里');\n    }",
                "",
            )
        ],
    },
    {
        "name": "已完成的 once schedule 可以 resume",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-structure-service.ts",
                "    if (current.status === 'completed' && status === 'active') {\n      throw conflict('一次性定时任务已经跑完，不能重新开启');\n    }",
                "",
            )
        ],
    },
    {
        "name": "updateMember 不同步 TeamMembership（归档后仍 active）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "    if (this.structure && input.status && input.status !== before.status) {\n      const team = this.defaultTeam();\n      this.structure.ensureAgentMembership(team.id, member.id);\n      this.structure.updateMembership(team.id, 'agent', member.id, {\n        status: member.status === 'active' ? 'active' : 'inactive',\n      });\n    }",
                "",
            )
        ],
    },
    {
        "name": "requireActiveMembership 不查 agent 的 member 行（漂移放行）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-structure-service.ts",
                "    if (kind === 'agent') {\n      const row = this.db.prepare(`SELECT status FROM member WHERE id = ?`).get(principalId) as\n        | { status: string }\n        | undefined;\n      if (!row || row.status !== 'active') {\n        throw forbidden(`Agent 已归档：${principalId}`);\n      }\n    }",
                "",
            )
        ],
    },
    {
        "name": "updateMembership 不保护最后一个 active owner",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-structure-service.ts",
                "      if (row.n === 0) {\n        throw conflict('团队至少要保留一个未归档的 owner');\n      }",
                "",
            )
        ],
    },
    {
        "name": "Agent 可以被提为 Team owner",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-structure-service.ts",
                "    if (kind === 'agent' && role === 'owner') {\n      throw badRequest('Agent 不能成为 Team owner');\n    }",
                "",
            )
        ],
    },
    {
        "name": "resolveActor 重新信任 X-Agent-Id 头（身份可伪造）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/middleware/teamScope.ts",
                "  const agentId = (req as { agentMemberId?: unknown }).agentMemberId;",
                "  const agentId = req.headers['x-agent-id'];",
            )
        ],
    },
    {
        "name": "internal 路由不注入 agent 身份（HTTP claim 路径断掉）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/routes/internal.ts",
                "  router.use('/members/:id', (req, _res, next) => {\n    (req as { agentMemberId?: string }).agentMemberId = req.params.id as string;\n    next();\n  });",
                "",
            )
        ],
    },
    {
        "name": "空 key 也造出一条引用（指向一张不存在的工单）",
        "test": "server/test/work-management.test.ts",
        "steps": [
            (
                "server/work-management/types.ts",
                "  const key = input.key?.trim();\n  if (!key) return null;\n",
                "  const key = input.key?.trim() ?? '';\n",
            )
        ],
    },
    {
        "name": "get() 不把引用规范成不可变 id（永远停在会变的 key 上）",
        "test": "server/test/work-management.test.ts",
        "steps": [
            (
                "server/work-management/jira-provider.ts",
                "        externalId: issue.id || issue.key,",
                "        externalId: issue.key,",
            )
        ],
    },
    {
        "name": "execution 收口时抹掉取证快照（历史只剩空壳）",
        "test": "server/test/work-management.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "        patch.externalWorkSnapshot !== undefined\n          ? serializeExternalWorkSnapshot(patch.externalWorkSnapshot)\n          : serializeExternalWorkSnapshot(current.externalWorkSnapshot),",
                "        serializeExternalWorkSnapshot(patch.externalWorkSnapshot ?? null),",
            )
        ],
    },
    {
        "name": "webhook 只按 key 匹配（工单改名后漏掉房间）",
        "test": "server/test/team-v1.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "           OR (\n             ? IS NOT NULL\n",
                "           OR (\n             0\n",
            )
        ],
    },
    # ── 唤醒原因的持久化读回 ──────────────────────────────────────────────
    # ── Member 记忆隔离：Team 上下文不出 Team ─────────────────────────────
    {
        "name": "remember_member 写全局（Team 上下文漏进所有 Team）",
        "test": "server/test/member-memory.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "    return Promise.resolve(this.members.appendTeamMemory(input.memberId, teamId, input.content));",
                "    return Promise.resolve(this.members.appendMemory(input.memberId, input.content));",
            )
        ],
    },
    # ── 哨兵不能泄漏到客户端 ──────────────────────────────────────────────
    # ── Capability 三层（global + team + member）────────────────────────────
    {
        "name": "三层合并顺序反了（member 被 global 盖住）",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/service.ts",
                "    return mergeCapabilities(this.getGlobal(), this.getTeam(teamId), this.getMember(memberId));",
                "    return mergeCapabilities(this.getMember(memberId), this.getTeam(teamId), this.getGlobal());",
            )
        ],
    },
    {
        "name": "跨层不去重（同一个资料源被解析两次）",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/service.ts",
                "      const key = `${binding.providerId}\\u0000${binding.selector ?? ''}`;\n      if (seen.has(key)) continue;\n      seen.add(key);\n",
                "",
            )
        ],
    },
    {
        "name": "改 Team 能力时顺带 touch 所有 Member（memberRevision 全体失真）",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/service.ts",
                "      this.deleteScope(scope);\n      this.insertBindings(scope, capabilities, timestamp);\n",
                "      this.deleteScope(scope);\n      this.insertBindings(scope, capabilities, timestamp);\n      this.db.prepare(`UPDATE member SET updated_at = ?`).run(timestamp);\n",
            )
        ],
    },
    # ── guard 是授权第一道闸（P0）──────────────────────────────────────────
    {
        "name": "guard 定义了但不执行（Policy 放行就能跑）",
        "test": "server/test/capabilities.test.ts",
        "steps": [
            (
                "server/capabilities/copilot-adapter.ts",
                "    if (tool.guard) {\n      const guardDecision = await tool.guard({ ...context, toolName: tool.name }, args);\n      if (!guardDecision.allowed) {\n        return { allowed: false, reason: guardDecision.reason };\n      }\n    }\n\n",
                "",
            )
        ],
    },
    # ── skill zip 的三道闸（P0）────────────────────────────────────────────
    {
        "name": "skill zip 不拒绝 symlink（把 workspace 外的东西带进来）",
        "test": "server/test/member-skills.test.ts",
        "steps": [
            (
                "server/skill-service.ts",
                "      if (stat.isSymbolicLink()) {\n        throw Object.assign(\n          new Error(`skill zip 不允许 symbolic link：${entry.name}`),\n          { status: 400 },\n        );\n      }\n\n",
                "",
            )
        ],
    },
    {
        "name": "skill zip 不限制解压后文件数（zip bomb）",
        "test": "server/test/member-skills.test.ts",
        "steps": [
            (
                "server/skill-service.ts",
                "      if (fileCount > MAX_EXTRACTED_FILES) {\n        throw Object.assign(\n          new Error(`skill zip 解压后文件数超过 ${MAX_EXTRACTED_FILES}`),\n          { status: 400 },\n        );\n      }\n\n",
                "",
            )
        ],
    },
    {
        "name": "解压前不校验 zip 条目（路径穿越写得出去）",
        "test": "server/test/member-skills.test.ts",
        "steps": [
            ("server/skill-service.ts", "      assertZipEntriesSafe(zipPath);\n", "")
        ],
    },
    {
        "name": "同名 skill 静默覆盖（丢掉已经装好的那一份）",
        "test": "server/test/member-skills.test.ts",
        "steps": [
            (
                "server/skill-service.ts",
                "      if (fs.existsSync(target)) {\n        throw Object.assign(new Error(`Skill ${name} 已存在`), { status: 409 });\n      }\n\n",
                "",
            )
        ],
    },
    {
        "name": "会话文件搜索不限定成员（非成员也能搜到别人的房间）",
        "test": "server/test/conversation-files.test.ts",
        "steps": [
            (
                "server/conversation-file-service.ts",
                "AND cm.member_id = ?",
                "AND ? IS NOT NULL",
            )
        ],
    },
    {
        "name": "会话文件的成员校验被跳过（谁都能读这个房间的文件）",
        "test": "server/test/conversation-files.test.ts",
        "steps": [
            (
                "server/conversation-file-service.ts",
                "if (!row) throw forbidden('你不是这个会话的成员，看不到这里的文件');",
                "void row;",
            )
        ],
    },
    {
        "name": "挂件不校验跨会话归属（在 B 讨论里引用 A 讨论的文件）",
        "test": "server/test/conversation-files.test.ts",
        "steps": [
            (
                "server/conversation-file-service.ts",
                "      if (row.conversation_id !== conversationId) {\n        throw forbidden('这个文件属于别的会话，不能在这里引用');\n      }\n",
                "",
            )
        ],
    },
    {
        "name": "上传去重不收敛（同一份文件在 Shared Files 里出现两份）",
        "test": "server/test/conversation-files.test.ts",
        "steps": [
            (
                "server/conversation-file-service.ts",
                "WHERE conversation_id = ? AND content_hash = ? AND original_name = ?",
                "WHERE conversation_id = ? AND content_hash != ? AND original_name = ?",
            )
        ],
    },
    {
        "name": "软删除改成物理删除（历史消息里的附件卡片凭空消失）",
        "test": "server/test/conversation-files.test.ts",
        "steps": [
            (
                "server/conversation-file-service.ts",
                "      .prepare(\"UPDATE conversation_file SET status = 'deleted', updated_at = ? WHERE id = ?\")\n      .run(now(), fileId);",
                "      .prepare('DELETE FROM conversation_file WHERE id = ?')\n      .run(fileId);",
            )
        ],
    },
    {
        "name": "上传后提取同步跑完（file.updated 先于 202 的响应写出）",
        "test": "server/test/conversation-files.test.ts",
        "steps": [
            (
                "server/conversation-file-processor.ts",
                "    setImmediate(() => {\n      void this.drain();\n    });",
                "    void this.drain();",
            )
        ],
    },
    {
        "name": "第二次挂同一份文件仍记成 attachment（丢掉了「引用」这个事实）",
        "test": "server/test/conversation-files.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "    return row ? 'reference' : 'attachment';",
                "    return row && false ? 'reference' : 'attachment';",
            )
        ],
    },
    {
        "name": "SCHEMA_SQL 少一列（形状契约与域模型脱节）",
        "test": "server/test/runtime-reliability.test.ts",
        "steps": [("server/db-migrations.ts", "  extraction_error TEXT,\n", "")],
    },
    {
        "name": "SCHEMA_SQL 少一个索引（形状契约与域模型脱节）",
        "test": "server/test/runtime-reliability.test.ts",
        "steps": [
            (
                "server/db-migrations.ts",
                "CREATE INDEX idx_message_file_file\n  ON conversation_message_file(file_id);\n\n",
                "",
            )
        ],
    },
    # ── Task 状态层 ─────────────────────────────────────────────────────
    {
        "name": "plan 不翻译依赖 key（依赖永远对不上，B 一直 pending）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "          dependencies_json: JSON.stringify((task.dependencies ?? []).map((dep) => idByKey.get(dep) ?? dep)),",
                "          dependencies_json: JSON.stringify(task.dependencies ?? []),",
            )
        ],
    },
    {
        "name": "plan 不检查循环依赖（A→B→A 直接落库）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    validateNoCycle(keys, input.tasks.map((task) => task.dependencies ?? []));\n",
                "",
            )
        ],
    },
    {
        "name": "update_task 不校验执行人（谁都能改别人的任务）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    if (task.assigneeMemberId !== input.memberId) {\n      throw badRequest('只能更新分给自己的任务');\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "非 Lead 也能规划任务（越权）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    if (input.leadMemberId && input.memberId !== input.leadMemberId) {\n      throw badRequest('只有负责这个工作的 Lead 才能制定任务计划');\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "Task turn 结束不自动收尾（任务永远停在 running）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "        this.tasks.markFailed(taskAfterTurn.id, 'Agent turn 结束时没有调用 update_task 报告任务完成或阻塞');\n        this.orchestrator.onTaskChanged(taskAfterTurn.id);\n",
                "",
            )
        ],
    },
    {
        "name": "Lead 忙时重复入队（同一轮被跑两遍）",
        "test": "server/test/team-service.test.ts",
        "steps": [
            (
                "server/task-orchestrator.ts",
                "    if (this.scheduler.isBusy(conversationId, leadMemberId) && reason !== 'lead_recovery') {\n      return false;\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "恢复时 running 的 Task 不置 blocked（重启后 UI 还显示在跑）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/recovery-service.ts",
                "          WHERE status = 'running'\n          `,\n        )\n        .run('服务重启导致执行中断，检查后可重试', timestamp);",
                "          WHERE status = 'never-running'\n          `,\n        )\n        .run('服务重启导致执行中断，检查后可重试', timestamp);",
            )
        ],
    },
    {
        "name": "plan 允许重复规划（第二次 plan 覆盖旧任务历史）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    if (this.list(input.conversationId).length > 0) {\n      throw badRequest('这个工作区已经存在任务，不能重新创建任务计划');\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "failed 不算未解决（全部失败的工作区变成 completed）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    if (rows.some((row) => row.status === 'blocked' || row.status === 'failed')) {",
                "    if (rows.some((row) => row.status === 'blocked')) {",
            )
        ],
    },
    {
        "name": "依赖失败不传染下游（B 永久 pending）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    if (states.some((s) => s === 'failed' || s === 'blocked' || s === 'cancelled')) return 'failed';",
                "    if (states.some((s) => s === 'failed' || s === 'blocked' || s === 'cancelled')) return 'waiting';",
            )
        ],
    },
    {
        "name": "retry 不查依赖（上游没好也能重试下游）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    if (!this.dependenciesCompleted(task)) {\n      throw badRequest('任务依赖尚未完成，不能重试：请先处理它依赖的任务');\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "完成的工作区继续收用户消息（已完成又被点燃）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "    if (conversation.status === 'completed' || conversation.status === 'cancelled') {\n      throw conflict('这个工作已经结束，不能再发消息：要继续做事请新建一个工作区');\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "任务开始后仍能增删成员（roster 随意变）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "    if (conversation.status !== 'intake' && conversation.status !== 'waiting_user') {\n      throw conflict('任务已经开始，不能修改成员');\n    }\n\n    const member = this.members.get(memberId);",
                "\n    const member = this.members.get(memberId);",
            ),
            (
                "server/team-service.ts",
                "    if (conversation.status !== 'intake' && conversation.status !== 'waiting_user') {\n      throw conflict('任务已经开始，不能修改成员');\n    }\n\n    // 移出前必须没有在飞的活。",
                "\n    // 移出前必须没有在飞的活。",
            ),
        ],
    },
    {
        "name": "Lead 规划降档用 Standard（Strong 被绕过）",
        "test": "server/test/model-policy.test.ts",
        "steps": [
            (
                "server/model-policy.ts",
                "    case 'planning':\n      return { model: policy.lead.strong.id, purpose: 'lead:planning' };",
                "    case 'planning':\n      return { model: policy.lead.standard.id, purpose: 'lead:planning' };",
            )
        ],
    },
    {
        "name": "唤醒原因被任务计数盖掉（clarification 误判成 planning）",
        "test": "server/test/model-policy.test.ts",
        "steps": [
            (
                "server/model-policy.ts",
                "  // 显式原因优先于任务计数：用户刚回答澄清 / 任务刚失败阻塞，\n  // 这一轮的性质由触发原因决定，而不是由“有没有 Task”猜。\n  if (input.wakeReason === 'lead_clarification') {\n    return 'clarification';\n  }\n  if (input.wakeReason === 'lead_recovery') {\n    return 'recovery';\n  }\n  // 没有 Task 时，Lead 的职责就是理解目标 / 澄清 / 初始规划。\n  if (input.taskCount === 0) {\n    return 'planning';\n  }",
                "  if (input.taskCount === 0) {\n    return 'planning';\n  }\n  if (input.wakeReason === 'lead_clarification') {\n    return 'clarification';\n  }\n  if (input.wakeReason === 'lead_recovery') {\n    return 'recovery';\n  }",
            )
        ],
    },
    {
        "name": "Task 完成也唤醒 Lead（最强模型看每个进度）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-orchestrator.ts",
                "    if (task.status === 'completed' || task.status === 'cancelled') {\n      this.startReadyTasks(task.conversationId);\n      this.recomputeAndEmit(task.conversationId);",
                "    if (task.status === 'completed' || task.status === 'cancelled') {\n      this.startReadyTasks(task.conversationId);\n      const conversation = this.readConversation(task.conversationId);\n      if (conversation?.leadMemberId) {\n        this.ensureLeadWake(task.conversationId, conversation.leadMemberId, conversation.messageSequence);\n      }\n      this.recomputeAndEmit(task.conversationId);",
            )
        ],
    },
    {
        "name": "Task Agent 的回答写进 Activity（与 Task 重复）",
        "test": "server/test/model-policy.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "      if (content && input.turnMode === 'lead') {",
                "      if (content) {",
            )
        ],
    },
    {
        "name": "recovery 唤醒也被 Lead 忙挡掉（失败通知丢失）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-orchestrator.ts",
                "    if (this.scheduler.isBusy(conversationId, leadMemberId) && reason !== 'lead_recovery') {\n      return false;\n    }",
                "    if (this.scheduler.isBusy(conversationId, leadMemberId)) {\n      return false;\n    }",
            )
        ],
    },
    {
        "name": "running 的 Task 可直接 cancel（与执行中 Execution 分裂）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/task-service.ts",
                "    if (task.status === 'running' && this.taskExecutionActive(task)) {\n      throw conflict('任务正在执行，请先取消对应的 Execution');\n    }\n",
                "",
            )
        ],
    },
    {
        "name": "没调 update_task 的 turn 自动 completed（做一半算做完）",
        "test": "server/test/task-service.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "        this.tasks.markFailed(taskAfterTurn.id, 'Agent turn 结束时没有调用 update_task 报告任务完成或阻塞');",
                "        this.tasks.markCompleted(taskAfterTurn.id, content || undefined);",
            )
        ],
    },
]


def mutate(mutation):
    """把全部步骤打上，返回 {路径: 变异后内容}；任一步没命中就返回 None。"""
    originals = {}
    mutated = {}
    for path, old, new in mutation["steps"]:
        text = mutated.get(path, originals.get(path))
        if text is None:
            text = (ROOT / path).read_text()
            originals[path] = text
        count = text.count(old)
        if count != 1:
            print(f"      ✗ {path}：期望命中 1 次，实际 {count} 次 —— 变异脚本要跟着实现改")
            return None
        mutated[path] = text.replace(old, new, 1)
    return originals, mutated


def preflight(test_files: list[str]) -> bool:
    """先跑一遍基线：任何一个测试文件自己就是红的，就不该开始做变异验证。

    这不只是「省得白跑」。还原靠的是内存里的原文，所以上一次运行被杀掉会留下一个
    停在某个变异上的源文件 —— 那种状态下继续跑，那条变异会报「变异没打上」，
    看起来像脚本的锚点写错了，实际是工作区不干净。基线红了就直接停，把话说清楚。
    """
    broken = [rel for rel in test_files if not run_test(rel)]
    if not broken:
        return True

    print("基线不干净：以下测试文件本身是红的，先修好再跑变异验证。")
    for rel in broken:
        print(f"  - {rel}")
    print("（若上次运行被中断，源文件可能还停在某个变异上 —— 看 git diff。）")
    return False


def main() -> int:
    # §8 要求变异验证只跑「本次改动对应的断言、受影响的文件」，所以支持按名字/测试
    # 路径过滤：`python3 scripts/mutation-check.py 会话文件`。不带参数就是全量。
    only = sys.argv[1] if len(sys.argv) > 1 else None
    selected = [
        mutation
        for mutation in MUTATIONS
        if only is None or only in mutation["name"] or only in mutation["test"]
    ]
    if not selected:
        print(f"没有名字或测试路径包含 {only!r} 的变异。")
        return 1

    if not preflight(sorted({mutation["test"] for mutation in selected})):
        return 1

    failures = []
    for index, mutation in enumerate(selected, start=1):
        print(f"[{index:>2}] {mutation['name']}")
        prepared = mutate(mutation)
        if prepared is None:
            failures.append(f"{index}（变异没打上）")
            continue

        originals, mutated = prepared
        try:
            for path, text in mutated.items():
                (ROOT / path).write_text(text)
            passed = run_test(mutation["test"])
        finally:
            for path, text in originals.items():
                (ROOT / path).write_text(text)

        if passed:
            print("      ✗ 测试仍然全绿 —— 这条断言没有区分度")
            failures.append(f"{index}（断言抓不住）")
        else:
            print("      ✓ 断言变红")

    print()
    if failures:
        print(f"变异验证有 {len(failures)} 条不成立：{', '.join(failures)}")
        return 1
    print(f"全部 {len(selected)} 条变异都被断言捕获。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
