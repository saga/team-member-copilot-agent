"""变异验证：把关键实现改回错误写法，确认对应的断言真的变红。

每个变异只改一处，跑一个定向测试文件，断言它失败，然后按内存里的原文还原
（不走 git —— 这些文件里可能有尚未提交的改动）。

**超时算「捕获」**：有些变异会把系统推进死循环（例如拿掉「已经有人回答过就不再兜底」
这一关，兜底会自我循环），测试不会红，而是一直跑下去。挂死也是一种失败 ——
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
    return "# fail 0" in result.stdout and result.returncode == 0


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
                "    if (kb.scope === 'personal' && kb.memberId !== memberId) {\n      throw forbidden('该 Member 没有访问这个 Knowledge Base 的权限');\n    }\n",
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
                "    const templateCapabilities: MemberCapabilities = template.capabilities;\n    resolver.validate(templateCapabilities);\n\n    const member = memberService.create(",
                "    const templateCapabilities: MemberCapabilities = template.capabilities;\n\n    const member = memberService.create(",
            ),
            (
                "server/member-template-seeder.ts",
                "    capabilities.replace(member.id, templateCapabilities);\n",
                "    capabilities.replace(member.id, templateCapabilities);\n    resolver.validate(templateCapabilities);\n",
            ),
        ],
    },
    {
        "name": "模板能力完全不校验",
        "test": "server/test/member-template-seeder.test.ts",
        "steps": [
            ("server/member-template-seeder.ts", "    resolver.validate(templateCapabilities);\n", "")
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
                "    if (!memberInConversation) {\n      throw badRequest('Schedule 的 Member 必须属于绑定的 work conversation');\n    }",
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
                "    if (current.status === 'completed' && status === 'active') {\n      throw conflict('已完成的 once schedule 不能 resume');\n    }",
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
                "      if (row.n === 0) {\n        throw conflict('Team 至少必须保留一个 active owner');\n      }",
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
    {
        "name": "用户消息不指定应答者（回到全员可沉默 → 责任扩散）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/group-dispatcher.ts",
                "      message.senderType === 'user' ? this.pickPrimaryResponder(conversation, candidates) : null;",
                "      null;",
            )
        ],
    },
    {
        "name": "应答者拿到的是「可以沉默」的指令（出口没关）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            ("server/context-assembler.ts", "  if (reason === 'direct') {", "  if (reason === null) {")
        ],
    },
    {
        "name": "应答者平手时不定序（谁回答取决于数组顺序）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/group-dispatcher.ts",
                "      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;",
                "      return 0;",
            )
        ],
    },
    {
        "name": "应答者排序方向反了（永远同一个人回答）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/group-dispatcher.ts",
                "      if (left !== right) return left - right;",
                "      if (left !== right) return right - left;",
            )
        ],
    },
    # ── 负责人兜底：房间全体沉默时，由负责人回答 ────────────────────────────
    {
        "name": "兜底被降级成普通讨论（负责人拿到「你可以沉默」）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            ("server/group-dispatcher.ts", "      reason: 'escalation',", "      reason: 'open_discussion',")
        ],
    },
    {
        "name": "兜底根本不派（房间沉默下去没人管）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "          this.maybeEscalateSilentRoom(input.conversation, input.triggerMessageSequence);",
                "          void input.triggerMessageSequence;",
            )
        ],
    },
    {
        "name": "有人已经回答过还兜底（负责人抢答）",
        "test": "server/test/team-chat.test.ts",
        "steps": [("server/team-service.ts", "    if ((counts.replies ?? 0) > 0) return;\n", "")],
    },
    {
        "name": "不等这一批跑完就兜底（一次沉默兜多次）",
        "test": "server/test/team-chat.test.ts",
        "steps": [("server/team-service.ts", "    if ((counts.active ?? 0) > 0) return;\n", "")],
    },
    {
        "name": "被静音的负责人照样被兜底唤醒（绕过用户的显式意图）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/group-dispatcher.ts",
                "    if (this.states.get(conversation.id, leadId).muted) return null;\n",
                "",
            )
        ],
    },
    {
        "name": "Member 之间的沉默也当成房间失职（兜底被滥用）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "    if (!trigger || trigger.senderType !== 'user') return;",
                "    if (!trigger) return;",
            )
        ],
    },
    {
        "name": "兜底合并时输给更弱的唤醒（「房间已沉默」这条信息丢掉）",
        "test": "server/test/team-chat.test.ts",
        "steps": [("server/member-turn-scheduler.ts", "  escalation: 4,", "  escalation: 1,")],
    },
    {
        "name": "兜底指令退化成 direct 的说辞（负责人会再判断一次）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            ("server/context-assembler.ts", "  if (reason === 'escalation') {", "  if (reason === 'never-match') {")
        ],
    },
    # ── 唤醒原因的持久化读回 ──────────────────────────────────────────────
    {
        "name": "escalation 没进读回白名单（崩溃恢复时被降级成 open_discussion）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/conversation-member-service.ts",
                "  escalation: true,\n  mention: true,",
                "  mention: true,",
            )
        ],
    },
    # ── 一个房间至多一个负责人 ────────────────────────────────────────────
    {
        "name": "换负责人时不撤销旧的（两个负责人，谁兜底不确定）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/conversation-member-service.ts",
                "          is_lead = CASE WHEN member_id = ? THEN ? ELSE 0 END,",
                "          is_lead = CASE WHEN member_id = ? THEN ? ELSE is_lead END,",
            )
        ],
    },
    {
        "name": "读负责人时不筛 is_lead（兜底落到随便一个成员头上）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/conversation-member-service.ts",
                "          AND is_lead = 1\n        LIMIT 1",
                "        LIMIT 1",
            )
        ],
    },
    # ── 哨兵不能泄漏到客户端 ──────────────────────────────────────────────
    {
        "name": "流式路径不过滤哨兵（用户会先看到 <NO_REPLY> 再看着它消失）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            ("server/team-service.ts", "          const visible = streamGate.push(delta);", "          const visible = delta;")
        ],
    },
    {
        "name": "收尾时不看判定结果（skip 的尾巴 = 哨兵本身，直接放出去）",
        "test": "server/test/team-chat.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "      const tail = streamGate.flush(outcome.decision);",
                "      const tail = streamGate.flush('reply');",
            )
        ],
    },
    {
        # 同一条变异，但钉在**客户端真正看到的字节流**上。
        #
        # 这一条单独存在是因为 SSE 断言有个非常容易踩的空绿：`message.delta` 是
        # 逐字符的，每个字符各占一帧，所以 `<NO_REPLY>` 在原始 body 里从来不会连续
        # 出现 —— 直接对 body 做字符串匹配**永远**为 false，包括哨兵真的漏出去时。
        # 必须解析帧、把 delta 拼起来再断言。这条变异保证那个解析真的做了。
        "name": "SSE 把 delta 原样转发（客户端会看到哨兵长出来再消失）",
        "test": "server/test/conversations-api.test.ts",
        "steps": [
            (
                "server/team-service.ts",
                "          const visible = streamGate.push(delta);",
                "          const visible = delta;",
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


def main() -> int:
    failures = []
    for index, mutation in enumerate(MUTATIONS, start=1):
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
    print(f"全部 {len(MUTATIONS)} 条变异都被断言捕获。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
