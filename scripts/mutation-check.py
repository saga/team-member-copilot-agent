"""变异验证：把关键实现改回错误写法，确认对应的断言真的变红。

每个变异只改一处，跑一个定向测试文件，断言它失败，然后按内存里的原文还原
（不走 git —— 这些文件里可能有尚未提交的改动）。
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_test(rel_path: str) -> bool:
    """跑一个测试文件，返回它是否通过。"""
    result = subprocess.run(
        ["node", "--import", "tsx", "--test", rel_path],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
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
