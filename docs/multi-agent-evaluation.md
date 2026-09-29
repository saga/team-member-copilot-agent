# Multi-Agent 策略评测

目标不是证明 Multi-Agent 更强，而是回答：**什么时候 Single、什么时候 Multi**。

## 方法

`scripts/agent-strategy-eval.ts` 跑真实场景（真实模型、真实计费），从 DB 收机器指标：

```text
latency / executions / byStatus / toolCalls / retries / humanReviewRequired
```

每个 scenario 跑 single（1 Member）和 multi（3 Member）各一次。quality / success
由人判定后填表 —— 模型给自己打分是作弊，脚本不做这部分。

```bash
npx tsx scripts/agent-strategy-eval.ts \
  --server http://localhost:3001 --dataDir .data \
  --members '<leadId>' \
  --title 'eval-decomposable-single' \
  --objective '对 3 家金融公司做基本面/风险/新闻研究'
```

server 需已启动且 `AUTH_DEV_MODE=true`。

## 三类任务

### A. Decomposable（可拆分研究）

例如：对 10 家金融公司做基本面/风险/新闻研究。比较 single strong agent vs
3 specialized workers。预期这是 Multi-Agent 最值得测试的类别。

### B. Independent Review（独立审查）

例如：Architect 设计 Agent 平台，Security 独立审查（`independentContext: true`）。
比较 single agent self-review vs independent security worker。重点看 security
findings、false negative、duplicate findings。

### C. Sequential Coding（串行工程）

例如：修改 API → 改 DB → 改测试 → 跑测试 → 修 bug。比较 single strong engineer
vs Architect → Engineer → Reviewer。这里很可能 Single-Agent 更划算（高耦合、
串行任务是 Multi-Agent 最容易吃亏的地方）。

## 记录表

| scenario | mode | quality(人判) | success(人判) | latency | executions | toolCalls | retries |
| -------- | ---- | ------------- | ------------- | ------- | ---------- | --------- | ------- |
|          |      |               |               |         |            |           |         |

读法是 quality×cost 象限，不是“谁分高谁赢”：Multi 只在 quality 明显更好、
且 cost 涨幅可接受时才选。打平一律选 single。
