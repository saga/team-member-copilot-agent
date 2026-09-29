Q：检查最新代码，搜索web，回答我的问题。我突然有个巨大的疑惑，现在这种multi agent member，使用不同persona / soul模拟不同个性的类人agent，真的有帮助，能解决问题么？还是其实和直接用chatgpt或者其它对话型AI加上一些mcp和agent skill，没有什么大区别？有没有相关研究和真实用例分析。

------

结合当前 `team-member-copilot-agent` 代码和截至 **2026 年 9 月**的研究，结论很直接：

> **“把一个 LLM 变成多个有名字、有性格、有 Soul 的人”本身，几乎不是一个有价值的智能架构。真正有价值的是把一个问题拆成不同的上下文、能力、数据、权限、工作单元和独立验证路径。**

也就是说，这个项目不应该把核心故事定义成“模拟一个 AI 团队里的不同人”，更准确的定义应该是：

> **一个 Orchestrator + 多个受约束、可独立执行、拥有不同能力/数据/工作上下文的 Agent Worker。**

而“Persona / Soul”只是这些 Worker 的一层配置，不应该是核心技术价值。

# 先回答最核心的问题

如果一边是“ChatGPT / Claude / Copilot + MCP + Skills + 一个很长的 system prompt（比如‘你现在是资深架构师’）”，另一边是 Architect / Security / Engineer 三个 Agent，但三者用同一个模型、同样的工具、同样的知识、同样的上下文，只是 system prompt 不同，那么后者通常没有足够强的技术优势，很多时候只是把一个 Agent 调了三遍，成本、延迟和错误传播反而更差。

2024 年 EMNLP 的系统性研究测试了 **162 种 persona、4 个模型家族、2,410 个事实型问题**，结论是：加 persona 并没有稳定提升任务性能；某些 persona 会提高某些题目的准确率，但选择哪个 persona 本身很困难，而且效果有明显随机性。([ACL Anthology][1])

2025 年 EMNLP 的后续研究进一步测试了 **9 个模型、27 个任务**：专家 persona 通常只带来正向或不显著变化，同时模型对 persona 中无关细节非常敏感，某些任务会出现接近 **30 个百分点**的性能下降。([ACL Anthology][2])

更直接的是 2026 年一项针对 persona 的研究，覆盖 **1,140 个开放问题、38 种专家角色、6 个领域**。它发现总体差异很小，persona 更稳定地改变的是“回答风格/专业深度”，而不是底层能力；而且出现了明显的“专业深度增加、清晰度下降”权衡。在金融、法律、科学、技术的概念性/解释性问题中，甚至可能是没有 persona 的 baseline 更好。([arXiv][3])

所以“你是资深架构师”“你是安全专家”“你是资深工程师”这类设定的作用不要被高估。

# 但是，多 Agent 又不是没意义

真正值得保留的是另一件事。

## 多 Agent 的价值来自“分工”，不是“人格”

把 Lead 拆成 Architect、Security、Engineer 三路并行，各自拿不同的 context、evidence 和 tools，和让一个 Agent 先想架构、再想安全、再写代码、最后自己检查自己，这两种是有本质区别的。前者可以产生下面三样东西。

### 1. 并行性

三个方向可以同时做。

Anthropic 的多 Agent Research 就明确发现，多 Agent 最适合的是**breadth-first、多个相对独立的调查方向**。他们的生产 Research 系统用一个 lead orchestrator 派发多个并行 subagents；在他们自己的 research eval 上，比单个 Opus 4 高 **90.2%**。同时他们发现多 Agent 通常消耗约聊天的 **15 倍 token**，所以只有高价值、可并行的问题才划算。([Anthropic][4])

### 2. 上下文隔离

这是你这个项目特别值得保留的东西。比如 Security Reviewer 只看安全要求、threat model 和 controls，Engineer 只看 code、repo、test 和 build，Architect 只看 business requirement 和 architecture，它们不需要都背着整个房间的所有历史。这和 ChatGPT 里“一个超长 context 加一句‘现在请你切换成安全专家’”不是一回事。

### 3. 不同能力边界

这是你当前代码里已经开始做对、也比“Persona”更重要的地方。你现在的 Member 并不只是 name、role、personality，实际已经有 systemPrompt、style、memory、model、skill、knowledge、tools、workspace、Copilot Session、task ownership、execution、delegation。例如当前模板里，Security Reviewer 带着 security-controls knowledge，Senior Engineer 带着 host coding tools，Solution Architect 带着 architecture-oriented prompt/skill，这才是有意义的 specialization。

换句话说，你现在代码里真正有价值的是 Capability / Knowledge / Tool / Runtime / Task，而不是 Soul。

# 研究现在给出的答案非常有意思：Multi-Agent 不是越多越好

这是 2026 年非常重要的趋势。

Nature Machine Intelligence 2026 年的一项系统实验，把 6 个 benchmark、5 种 agent architecture、3 个 LLM family、260 个受控配置放在一起比较，直接问多 Agent 到底什么时候比单 Agent 好。结果不是“多 Agent 更强”，而是先看单 Agent 本身有多强：当单 Agent 已经超过一个能力饱和阈值后，多 Agent 经常没好处，甚至变差。这个研究给出的经验阈值大约在 **45% baseline capability** 附近，并且在 SWE-bench Verified 和 Terminal-Bench 上，对多 Agent 是否会提升的方向判断可以达到约 **94%**。([Nature][5])

最有意思的是细项结果。在 Finance Agent benchmark 上，部分集中式 Multi-Agent 架构确实有非常明显的收益：Anthropic 约 **+127.5%**，Google 约 **+164.3%**，OpenAI 约 **+69.9%**。但在 PlanCraft 上，多 Agent 反而最多下降 **54.5%**。在 SWE-bench Verified 上，单 Agent 是 0.488，而 Hybrid（0.481）、Centralized（0.475）、Decentralized（0.456）、Independent（0.425）全部低于单 Agent。([Nature][5])

这对你的项目特别重要：**金融分析这种“多个相对独立 analytical lenses”可能很适合多 Agent；连续的工程实现、强依赖的任务链，不一定适合。**

# 2026 年另一项研究甚至更直接

BenchAgent 对单 Agent 和多 Agent 做 protocol-aligned 的比较，在 10 个 reasoning / coding / tool-use benchmark 上用统一的工具、loader、计费和轨迹记录。结果是 6 个固定 MAS 中最多只有 1 个超过匹配的单 Agent anchor，其余 5 个落后 **2.56～11.29 个百分点**，同时成本更高。([arXiv][6])

另一篇 2025 年的研究也得到类似结论：LLM 越强，MAS 相对 SAS 的优势越小。并且他们测到 Multi-Agent 的 prefill token 消耗可能是 Single-Agent 的 **4～220 倍**；即使完美复用上下文，生成 token 也高约 **2～12 倍**。([alphaXiv][7])

所以今天已经越来越不能把“多 Agent = 更聪明”作为架构假设。

# 但“独立审查”是另一回事

这个恰恰是你的项目很值得保留的方向。比如 Architect 出设计方案，Security Reviewer 做独立审查，Engineer 验证实现，而不是一个 Agent 先说“我是架构师”、自己设计、自己说安全、自己说实现没问题。这类 multi-agent debate / verification 有比较扎实的研究基础。

ICML 2024 的 Multi-Agent Debate 研究发现，让多个模型实例独立提出方案、互相批评、再综合，可以提高数学、战略推理和事实正确性。([Proceedings of Machine Learning Research][8])

但这里有一个非常重要的条件：**多 Agent 必须尽量创造独立的错误来源。**否则 Agent A、B、C 用同一个模型，只会得到相同的错误，也就是 3 个模型同时犯一样的错误，而不是真正的“独立验证”。

所以真正值得做的是让 Architect 拿 architecture evidence，Security 拿 security controls 加 threat data，Engineer 拿 actual repository 加 test results，甚至可以 Lead 用 GPT-5、Security 用 Claude、Engineer 用 GPT-5-mini，或者至少保证不同的 context、不同的 evidence、不同的 tool set、不同的 acceptance criteria，而不是仅仅在 system prompt 里写一句“You are Security Reviewer”。

# 真实案例也非常说明问题

## 1. Anthropic Research：真正值得多 Agent

这是目前最有说服力的真实生产案例。他们实际生产的 Research 系统是 Lead Researcher 派发 Subagents，做 parallel web research，产出 independent findings，最后 Lead synthesis。他们明确说，最适合的是 breadth-first research、多个独立搜索方向、超过单一 context 能力的任务、大量复杂工具调用；而不适合所有 Agent 必须共享同一 context、子任务高度依赖、多数传统 coding task 的场景。([Anthropic][4])

这个和你现在的 architecture 非常吻合。

## 2. Anthropic 2026 C Compiler：Multi-Agent 真正改变了规模

Anthropic 让 **16 个 Agent** 并行构建 C compiler，结果是约 2,000 个 Claude Code sessions、约 $20,000、约 100,000 行代码，编译出 Linux 6.9。这里的关键不是“16 个不同人格”，他们自己的经验非常明确：多 Agent 的价值在于 **parallelism + specialization**。([Anthropic][9])

他们还明确发现，当 16 个 Agent 被迫解决同一个强耦合问题时，**16 个 Agent 并没有帮助**，后来需要增加 GCC 这个“外部 oracle”来打破共同错误。([Anthropic][9])

这个案例几乎就是你这个项目最重要的设计启示：**不是有 16 个“人”所以成功，而是有 16 个可以独立推进的工作单元。**

## 3. JPMorgan Chase：这是与你的金融场景最接近的真实案例

2026 AAAI 发表了 JPMorgan Chase 的 MAFA（Multi-Agent Framework for Annotation），这是明确的 production-deployed system。它不是“金融专家人格 A/B/C”的组合，而是 Specialized Agents 加 Structured Reasoning 再加 Judge-based Consensus。生产数据是：消除 **100 万条** annotation backlog，平均 **86%** 与人工标注者一致，每年节省 **5,000+ 小时**；相比单 Agent / 传统 baseline，Top-1 +13.8%、Top-5 +15.1%、F1 +16.9%。而且它明确区分 high、medium、low 三档 confidence，把人工留给 ambiguity 高的部分。([AAAI Publications][10])

这非常值得你学习。因为它的核心不是“模拟一个人类团队”，而是**让不同 agent 处理不同认知步骤，然后用 judge / consensus 解决最后的可靠性问题。**

## 4. Schroders：金融研究也是典型例子

Schroders 和 Google Cloud 做了 multi-agent financial research assistant prototype，把金融研究拆成不同分析方向，让不同 agent 处理不同类型的信息，再由上层整合。([Google Cloud][11])

另有金融投资研究论文把 fundamentals、sentiment、risk 拆成不同 Agent，对 30 家 Dow Jones 公司 2023 年 10-K 做实验，也报告了相对于单 Agent 的改进。([arXiv][12])

2026 年的另一项投资研究工作甚至直接指出，粗粒度的“Analyst / Manager”人格划分不够，真正重要的是 fine-grained task decomposition。这句话对你的项目特别重要。([arXiv][13])

## 5. Microsoft 自己也在走这个方向，但不是“模拟员工”

Microsoft 2026 年公开的 Secure Future Initiative 多 Agent 系统，用 Orchestrator、Analysis Agents、Evidence-gathering Agents 去分析整个云服务。重点是不同 Agent 分别检查代码、身份、配置、网络、runtime 等不同证据，然后发现组合型漏洞。也就是说，是 specialized evidence 加 independent analysis 加 orchestration 才产生价值，而不是让一个 Agent “扮演安全专家”。([Microsoft][14])

# 所以，我重新审视你现在这个项目

你现在实际上有两套东西混在一起。

## 第一层：我认为值得保留

Team、Member、Task、Execution、Runtime、Capability、Knowledge、Skill、Memory、Delegation、Scheduler 这一套很有价值，因为它真正增加了上下文隔离、能力隔离、数据隔离、并行执行、独立工作单元、持久状态、任务所有权、失败恢复和审计。

## 第二层：我认为你应该降级其重要性

Personality、Style、Soul，以及“这个 Member 像一个真实的人”，这东西有 UX 价值。例如“找 Security Reviewer”比“调用 security_review skill”在产品体验上更自然。但从解决问题的能力来说，Soul / Personality 不是核心。

# 你真正应该把 Member 定义成什么？

我建议从 **AI Team Member** 逐渐转成 **Specialized Agent Worker**，只是 UI 仍然可以叫 Member。

内部真正的模型可以是 Member，包含 Identity / Name、Role、Model、Capability Set、Knowledge Scope、Memory、Workspace、Task Ownership、Runtime Session 和 Output Contract，而 Personality、Style、Soul 应该退到最后。

# 你的三个默认 Member，其实可以这样重新定义

### Architect

不是“一个性格像资深架构师的人”，而是 Architecture Planner：Inputs 是 business requirements、system constraints、existing architecture；Knowledge 是 architecture / enterprise standards；Output 是 ADR、architecture options、trade-off 和 decision。

### Security

不是“一个性格比较怀疑的安全专家”，而是 Independent Security Reviewer：Inputs 是 architecture proposal、implementation evidence、security controls；Knowledge 是 security controls；Output 是 Threats、Attack paths、Missing controls、Required evidence 和 Pass/Fail 条件。而且应该尽量看不到 Architect 的最终结论，先独立分析。

### Engineer

不是“一个爱写代码的工程师”，而是 Implementation Worker：Inputs 是 approved design、task specification、repo；Tools 是 filesystem、bash、tests、git；Output 是 code、tests、build evidence 和 implementation status。

这样它们才真的不同。

# 这时你这个系统和“ChatGPT + MCP + Skills”才真正拉开差距

可以这么理解，ChatGPT + MCP + Skills 是一个 One Agent 带着 MCP、Skills、Memory，它已经可以完成非常多事情。所以你的 Team Agent 必须证明“一个强 Agent 做不到的事情”。

而有意义的 Team Agent 是 Lead 下面挂 Architecture、Security、Engineer，各自拿不同的 Context、KB、Repo 和工具（Context A 配 KB A，Context B 只读，Context C 能写代码），最后汇入 Independent Verification 再出 Result。这时它已经不是“三个 ChatGPT”，而是三个隔离的计算/认知工作单元。

# 我最建议你改变的一件事情

现在不要再问“这个 Agent 的 Personality 应该是什么”，而应该问：**“这个 Agent 和另一个 Agent 有什么不可替代的不同？”**

我建议强制回答下面 6 个问题：

| 问题                  | 没有明确答案时      |
| ------------------- | ------------ |
| 它能看到什么不同的数据？        | 不值得独立成 Agent |
| 它拥有哪些不同工具？          | 不值得独立成 Agent |
| 它的工作上下文有什么不同？       | 不值得独立成 Agent |
| 它产生什么不同类型的结果？       | 不值得独立成 Agent |
| 谁消费它的结果？            | 不值得独立成 Agent |
| 为什么一个 Agent 不能直接完成？ | 不值得独立成 Agent |

这六个问题，比 name、personality、style、soul、bio 重要得多。

# 对你这个项目，我会采用这个判断规则

默认用 Single Agent + MCP + Skills，遇到下面情况才升级 Multi-Agent：

1. 有 2+ 个可以真正并行的独立工作
2. 需要独立第二意见 / adversarial review
3. 不同工作需要不同数据权限
4. 不同工作需要不同工具能力
5. 单一 context 放不下整个问题
6. 任务需要长时间持续执行
7. 不同工作需要不同模型/成本档位

这基本和现在 Anthropic 的真实经验、2026 年 Nature 的实验结果、BenchAgent 的结论是一致的。([Anthropic][4])

# 最后给你一个非常重要的判断

你现在这个项目真正应该避免的方向是 AI Employee #1、#2、#3、#4，每个人都有名字、头像、性格、Soul、人生故事，然后 Lead 问一句“Bob，你怎么看”，Bob 回答“作为资深架构师，我认为……”。这非常容易变成昂贵的角色扮演。

而真正有价值的方向是 Lead 做 Task decomposition，派给 Specialized Workers，各自拿 Independent Evidence，做 Independent Review 和 Deterministic Verification，最后 Final synthesis。

所以我对你现在 `team-member-copilot-agent` 的判断是：

> **项目本身没有走错，但“Member = 一个有灵魂的数字员工”这个产品叙事需要降级；“Member = 一个持久、隔离、有专属能力/数据/工作上下文的 Agent Worker”才是技术上真正成立的模型。**

尤其对你做的**金融服务 Agent Team**，最值得投入的不是让 Architect、Security、Engineer 更“像人”，而是让三者形成真正不同的 **evidence / capability / context / responsibility / verification boundary**。

[当前 team-member-copilot-agent 仓库](https://github.com/saga/team-member-copilot-agent?utm_source=chatgpt.com)

[1]: https://aclanthology.org/2024.findings-emnlp.888/?utm_source=chatgpt.com "When ”A Helpful Assistant” Is Not Really Helpful: Personas in System Prompts Do Not Improve Performances of Large Language Models - ACL Anthology"
[2]: https://aclanthology.org/2025.emnlp-main.1364/?utm_source=chatgpt.com "Principled Personas: Defining and Measuring the Intended Effects of Persona Prompting on Task Performance - ACL Anthology"
[3]: https://arxiv.org/abs/2605.29420 "When Does Persona Prompting Actually Help? A Retrieval and Metric Analysis of Expert Role Injection in LLMs"
[4]: https://www.anthropic.com/engineering/multi-agent-research-system?utm_source=chatgpt.com "How we built our multi-agent research system \ Anthropic"
[5]: https://www.nature.com/articles/s42256-026-01268-y?utm_source=chatgpt.com "Capable language models can outgrow the benefits of collaboration | Nature Machine Intelligence"
[6]: https://arxiv.org/abs/2606.05670?utm_source=chatgpt.com "Do More Agents Help? Controlled and Protocol-Aligned Evaluation of LLM Agent Workflows"
[7]: https://www.alphaxiv.org/zh/abs/2505.18286?utm_source=chatgpt.com "单智能体还是多智能体系统？为何不兼而有之？ | alphaXiv"
[8]: https://proceedings.mlr.press/v235/du24e.html?utm_source=chatgpt.com "Improving Factuality and Reasoning in Language Models through Multiagent Debate"
[9]: https://www.anthropic.com/engineering/building-c-compiler "Building a C compiler with a team of parallel Claudes \ Anthropic"
[10]: https://ojs.aaai.org/index.php/AAAI/article/view/41431 "MAFA: A Multi-Agent Framework for Enterprise-Scale Annotation with Configurable Task Adaptation | Proceedings of the AAAI Conference on Artificial Intelligence"
[11]: https://cloud.google.com/blog/topics/customers/how-schroders-built-its-multi-agent-financial-analysis-research-assistant?utm_source=chatgpt.com "Schroders creates multi-agent AI assistant for complex financial research using Vertex AI Agent Builder | Google Cloud Blog"
[12]: https://arxiv.org/abs/2411.04788?utm_source=chatgpt.com "Enhancing Investment Analysis: Optimizing AI-Agent Collaboration in Financial Research"
[13]: https://arxiv.org/abs/2602.23330?utm_source=chatgpt.com "Toward Expert Investment Teams:A Multi-Agent LLM System with Fine-Grained Trading Tasks"
[14]: https://www.microsoft.com/en-us/security/blog/2026/07/08/protecting-microsoft-at-ai-speed-how-sfi-proactively-hardens-our-cloud/?utm_source=chatgpt.com "Protecting Microsoft at AI speed: How SFI proactively hardens our cloud   | Microsoft Security Blog"


-----------


我按当前 `main` 最新代码重新对照了一遍。核心调整不是把 Multi-Agent 删掉，而是把现在“**Member = 人格/人设**”这条设计线砍掉，保留“**Member = 有独立上下文、能力、数据、任务和运行时的 Specialized Worker**”。

研究给出的信号非常一致：Persona 本身没有稳定的能力增益，甚至可能因为无关 persona 信息而退化；而 Multi-Agent 真正有效的地方是并行、专业化、独立验证、上下文/工具/权限边界。2026 年 Nature 的大规模受控实验还显示，强 Single-Agent 在很多任务上已经比固定 Multi-Agent 更好；BenchAgent 也发现 6 个固定 MAS 里最多只有 1 个超过对应的 Single-Agent。([ACL Anthology][1])

## 一、先定最终方向

### 直接删除

| 现在的东西                            | 处理           |
| -------------------------------- | ------------ |
| `Member.style` 独立字段              | **删除**       |
| `SOUL.md`                        | **删除生成机制**   |
| `Personality / Style` UI         | **删除**       |
| Multi-member mention 中自动注入前面成员答案 | **删除**       |
| Lead 默认“多找几个成员一起做”               | **删除这种默认倾向** |
| “Member 是一个有性格的 AI 同事”作为技术定义     | **删除**       |

### 保留，但重新定义

| 现在的东西                 | 新定义                      |
| --------------------- | ------------------------ |
| `Member.name`         | UI / identity            |
| `Member.handle`       | mention / routing        |
| `Member.role`         | **工作职责**                 |
| `Member.description`  | UI 摘要，不再作为 prompt 中的人格描述 |
| `Member.systemPrompt` | **Work Contract / 工作契约** |
| `Member.model`        | 模型路由                     |
| Memory                | 长期上下文                    |
| Knowledge             | 专业数据                     |
| Skills                | 方法                       |
| Tools / MCP           | 能力边界                     |
| MemberRuntime         | 独立运行上下文                  |
| Task                  | 持久工作单元                   |
| Execution             | 实际运行                     |
| `ask_member`          | 聚焦 delegation            |
| `message_member`      | 人工/Agent 间通信             |
| Team                  | 组织和权限边界                  |

### 新增

只新增一个真正值得的概念：

```ts
ConversationTask.independentContext: boolean
```

它解决 Multi-Agent 最有价值的一类场景：

> **Security Reviewer / 第二意见 / 独立验证，不能先读 Architect 的结论再“审核 Architect”。**

---

# 二、第一批必须改：删掉 Persona/Soul 这条链

## 1. `server/domain.ts`

### 删除

```ts
style: string;
```

Member 改成：

```ts
export interface Member {
  id: string;
  handle: string;
  name: string;

  /** 工作职责，不等于能力。 */
  role: string;

  /** 给 UI 展示的简短说明，不作为授权，也不作为主要模型指令。 */
  description: string;

  /**
   * Member 的工作契约 / system prompt。
   *
   * 描述它负责什么、如何工作、输出什么、哪些事情不负责。
   * 不代表授权，也不是安全边界。
   */
  systemPrompt: string;

  model: string | null;
  status: MemberStatus;
  seedKey: string | null;
  createdAt: string;
  updatedAt: string;
}
```

同时把注释中的：

```text
人格
SOUL
personality
```

全部改成：

```text
identity
work contract
working behavior
```

不要再创建 `Persona` interface。

---

# 三、`server/db-migrations.ts`

现在 schema 是 30，直接改成 31。

你当前仓库本来就明确选择了“schema 不做兼容 migration，直接重建”的策略，因此这里不用搞 migration chain。

### `member` 表删除：

```sql
style TEXT NOT NULL DEFAULT '',
```

变成：

```sql
CREATE TABLE member (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  seed_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `conversation_task` 新增：

```sql
independent_context INTEGER NOT NULL DEFAULT 0
  CHECK (independent_context IN (0, 1)),
```

建议放在：

```sql
model_tier
```

附近。

语义：

```text
0 = 正常共享工作上下文
1 = 独立分析，不读取共享房间 transcript
```

然后：

```text
SCHEMA_VERSION = 31
```

不要增加第二个所谓 `context_policy` / `review_mode` / `blind_review_mode`，一个 boolean 已经够。

---

# 四、`server/member-service.ts`

这是第二个最应该砍的地方。

## 删除这些

```ts
import fs from 'node:fs';
import path from 'node:path';
```

删除：

```ts
style
```

相关 create / update / row mapping。

最重要的是：

```ts
private writeSoul(member: Member): void
```

整个删除。

以及：

```ts
this.writeSoul(member);
```

两个调用全部删除。

### 原来：

```ts
this.writeSoul(member);
return member;
```

改成：

```ts
return this.get(id);
```

---

## 为什么 `SOUL.md` 可以直接删

现在代码里 Member 真正运行时用的是：

```text
member row
+
Member Memory
+
Team Memory
+
Capability Resolver
+
ContextAssembler
```

`SOUL.md` 只是把 `name / role / style / systemPrompt` 再复制一份到文件。

它不是独立状态，也不是 Copilot SDK 的必要输入。

所以它属于：

> 第二份真相源 + 类人化装饰

这种文件现在删掉不会损失真正的 Agent 能力。

旧 `.data/members/*/SOUL.md` 可以在开发环境重建时直接消失；生产文件以后不再生成即可。

---

# 五、`server/routes/members.ts`

删除：

```ts
style: z.string().max(2000).optional(),
```

create/update schema 都删。

最终：

```ts
const createMemberSchema = z.object({
  name: z.string().trim().min(1).max(100),
  handle: z.string().trim().min(1).max(50).optional(),
  role: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  systemPrompt: z.string().max(12000).optional(),
  model: z.string().trim().min(1).max(100).optional(),
});
```

更新 schema 同样删除。

把注释：

```text
Member identity / personality
```

改为：

```text
Member identity / work contract
```

---

# 六、`server/member-template-seeder.ts`

删除 schema 中：

```ts
style: z.string().max(2000).default(''),
```

模板不再支持：

```json
"style": "..."
```

### `member.json` 改成

例如 Architect：

```json
{
  "key": "financial-services.solution-architect",
  "handle": "architect",
  "name": "Senior Solution Architect",
  "role": "Senior Financial Services Solution Architect",
  "description": "负责金融服务领域的端到端解决方案设计、架构评审和技术选型。",
  "model": null,
  "systemPromptFile": "SYSTEM_PROMPT.md",
  "memoryFile": "MEMORY.md",
  "capabilities": {
    "skills": [
      { "providerId": "member.filesystem-skills" }
    ],
    "knowledge": [
      { "providerId": "local.filesystem-knowledge", "selector": "$personal" }
    ],
    "tools": []
  },
  "enabled": true
}
```

这样一个 Member 就只剩：

```text
Identity
Role
Work Contract
Model
Capabilities
Memory
```

这已经足够。

---

# 七、三个 `SYSTEM_PROMPT.md` 全部重新定位

文件不删，但内容需要明显调整。

研究表明，Persona 本身没有稳定收益，所以不要再写：

```text
你是一位资深……
你的性格……
你应该表现得……
```

改成工作契约。

---

## `financial-solution-architect/SYSTEM_PROMPT.md`

开头改成：

```md
# Role

You are the architecture planning worker for this team.

Your job is to turn business requirements and constraints into an implementable
solution architecture.

You are responsible for:

- architecture boundaries
- technology choices
- integration design
- data architecture
- runtime architecture
- security architecture
- resilience
- governance
- architecture trade-offs

## Output contract

A useful architecture result should normally contain:

- facts
- requirements
- constraints
- assumptions
- options
- trade-offs
- recommended design
- risks
- unresolved questions
- verification items

Do not invent missing business requirements.

Do not use your role as authority.

Do not treat your conclusion as an authorization decision.

Your output is architecture input for other workers and humans.
```

这里继续保留金融服务那一整套控制原则。

但删除：

```text
不要假装自己是其他 Member
```

这种人格化描述，改成：

```text
Do not perform work that belongs to another task owner unless explicitly assigned.
```

---

# 八、Security Reviewer 要做一次比较重要的变化

`config/member-templates/financial-security-reviewer/SYSTEM_PROMPT.md`

现在这部分：

```text
如果问题需要整体架构判断，可以 ask_member 给 Solution Architect。
```

不要再作为默认行为。

改成：

```md
## Independent review

When reviewing another worker's architecture or implementation:

1. Inspect the supplied artifacts and authoritative evidence yourself.
2. Form your preliminary findings before reading another worker's conclusions.
3. Do not treat another agent's conclusion as evidence.
4. Do not copy another worker's assumptions without verification.
5. If an important artifact is missing, request the artifact instead of asking another
   worker for their conclusion.
6. Only perform a comparative review when the task explicitly asks for one.
```

这一点非常重要。

因为 Multi-Agent 真正有价值的一个方向是：

```text
Architect
   ↓
Security independent review
```

而不是：

```text
Architect:
  “我认为没问题”

Security:
  “我看看 Architect 说的……嗯，确实没问题”
```

ICML 的 multi-agent debate 研究也说明，多 Agent 的价值依赖于真正形成不同分析路径；如果各实例共享同样输入和偏差，多 Agent 很容易变成重复计算。([Proceedings of Machine Learning Research][2])

---

# 九、Engineer 的 SYSTEM_PROMPT

重点不变，但改成：

```md
# Role

You are the implementation worker.

Your job is to turn approved requirements, architecture inputs and task specifications
into working software.

## Output contract

A completed implementation should provide:

- changed files
- implementation result
- tests
- validation evidence
- remaining issues
- rollback / migration considerations when relevant
```

核心不变：

```text
code
test
concurrency
reliability
idempotency
runtime
```

这个角色本来就已经是“能力 specialization”，不是人格 simulation。

---

# 十、`server/execution-service.ts`

这是目前真正把 Persona 送进模型的地方。

当前：

```ts
`You are ${member.name}`,
`Role: ${member.role}`,
`Description: ${member.description}`,
`Style: ${member.style}`,
member.systemPrompt,
```

改成：

```ts
`Member role: ${member.role}`,
'',
'Work contract:',
member.systemPrompt,
```

`description` 保留给 UI，但不要作为模型输入。

这样模型看到的是：

```text
Member role: Financial Services Security Reviewer

Work contract:
...
```

而不是：

```text
You are Bob
Description: ...
Style: ...
You are ...
```

### 其余这些继续保留

```text
Authorization rule
Knowledge policy
Evidence policy
Memory
Team context
Task completion rules
Delegation rules
```

因为这些不是 Persona，而是运行规则。

---

# 十一、`src/components/team/MemberEditor.tsx`

这里是目前最明显的“Persona 产品化”。

当前：

```text
Personality / Style
```

整个字段删掉。

同时把：

```text
System Prompt
```

改成：

```text
Work Instructions
```

建议 helper：

```text
定义这个 Member 负责什么、怎么工作、需要输出什么。

它不是权限配置。
专业能力主要由 Role、Knowledge、Skills、Tools、MCP 和 Task 决定。
```

表单最终只保留：

```text
Name
Handle
Role
Description
Work Instructions
Task Model
```

这已经非常干净。

---

# 十二、`src/components/team/MemberProfile.tsx`

当前：

```text
Profile —— 它是谁（跨 Team 稳定的人格）
```

改：

```text
Profile —— Identity & Work Contract
```

Tab 不变：

```text
Profile
Memory
Team Context
Skills
```

这一套结构本身没问题。

---

# 十三、`src/components/team/NewMemberForm.tsx`

如果当前存在：

```text
Personality / Style
```

同样删除。

Member 创建页面不要再出现：

```text
Personality
Soul
Tone
Character
```

只保留：

```text
Name
Role
Description
Work Instructions
Model
```

---

# 十四、`src/lib/api.ts`

同步删除 `Member` 和 create/update 类型中的：

```ts
style
```

否则前后端类型还会残留。

---

# 十五、增加真正有价值的 `independentContext`

这是整个修改里唯一我建议新增的业务字段。

## `server/domain.ts`

增加：

```ts
export interface ConversationTask {
  // ...

  /**
   * 是否独立分析。
   *
   * true 时不把房间内其它 Agent 的讨论结果注入本次 Task 的共享上下文，
   * 防止第二意见被第一意见锚定。
   */
  independentContext: boolean;

  // ...
}
```

默认：

```ts
false
```

---

# 十六、`server/task-service.ts`

所有 Task 创建 / replan / add 的输入增加：

```ts
independentContext?: boolean;
```

落库时：

```ts
independentContext: input.independentContext ?? false
```

读取时：

```ts
independentContext: row.independent_context === 1
```

不要再设计：

```text
contextPolicy
reviewMode
blindMode
evidenceMode
analysisIsolationMode
```

这些现在都没必要。

---

# 十七、`server/task-application-service.ts`

以下输入增加：

```ts
independentContext?: boolean;
```

涉及：

```ts
planTasks()
addTask()
replanTasks()
```

然后原样传给 `TaskService`。

---

# 十八、`server/capabilities/providers/core-tools.ts`

这是非常重要的一处。

## `plan_tasks`

在 task schema 中增加：

```ts
independentContext: z.boolean().optional()
```

并且 description 加：

```text
Do not create multiple tasks merely to simulate different team members.

Prefer one strong worker when one worker can complete the work.

Use multiple workers only when the work has genuinely different:
- parallel workstreams
- data or capability boundaries
- tools
- contexts
- responsibilities
- independent review requirements

Set independentContext=true for an independent second opinion or adversarial review.
```

---

## `add_task`

同样：

```ts
independentContext: z.boolean().optional()
```

---

## `replan_tasks`

同样增加。

---

# 十九、`server/context-assembler.ts`

这是第二个最重要的代码改动。

现在无论 Task 类型，都会把 shared room history 注进去。

需要改成：

```ts
const isolatedTask =
  input.turnMode === 'delegation' ||
  (
    input.turnMode === 'task' &&
    input.currentTask?.independentContext === true
  );
```

然后：

```ts
const relevant = isolatedTask
  ? []
  : messages.filter(/* existing rules */);
```

### 但是有一个关键点

不能因为没读 shared messages，就把 checkpoint 推进。

现在：

```ts
const consumedThroughSequence =
  messages.length > 0
    ? messages[messages.length - 1].messageSequence
    : input.runtime.lastContextMessageSequence;
```

改成：

```ts
const consumedThroughSequence = isolatedTask
  ? input.runtime.lastContextMessageSequence
  : messages.length > 0
    ? messages[messages.length - 1].messageSequence
    : input.runtime.lastContextMessageSequence;
```

否则独立 Task 会把自己根本没读过的房间消息标记成“已经消费”。

---

# 二十、`delegation` 默认改成独立上下文

目前：

```text
ask_member
```

虽然是一个明确子任务，但还能拿到不少房间讨论。

建议改成：

```text
delegation = task package + structured workspace facts
```

不要自动拿：

```text
之前 Architect 说了什么
之前 Engineer 说了什么
其他成员得出了什么结论
```

调用：

```ts
ask_member({
  task: "请检查这个 API 的 authorization...",
})
```

调用方必须在 `task` 里给足需要的信息。

这是非常符合 Anthropic 实际多 Agent 经验的：多 Agent 最适合独立、并行、相对清晰的工作块，而不是所有成员共享整块上下文。([Anthropic][3])

---

# 二十一、删除当前 Multi-member Mention 的“互相影响”

这是我认为当前代码里最应该直接删除的一块。

现在：

```ts
findPreviousMentionResponses(...)
```

然后：

```text
Previous Member responses to this same user request:
...
Build on them instead of repeating them.
```

这会主动制造：

```text
A → B → C
```

而不是：

```text
A
B
C
   ↓
Lead synthesis
```

## 删除这段 prompt 注入

整个：

```ts
if (input.turnMode === 'mention' && ...)
```

读取 previous mention responses 并重新注入的逻辑删掉。

---

## `MEMBER_MENTION_INSTRUCTION`

现在的：

```text
Review those earlier answers
Build on them
If another Member identified...
```

全部删掉。

改成：

```ts
const MEMBER_MENTION_INSTRUCTION = [
  'You were directly addressed by the user.',
  'Answer independently from your assigned role, available capabilities, and evidence.',
  '',
  'Other Members may provide different answers.',
  'Do not treat another Member conclusion as evidence.',
  'Do not anchor on another Member conclusion unless the user explicitly asks for a comparison or review.',
  'Focus on your own analysis and the evidence available to you.',
  '',
  'DIRECT RESPONSE:',
  'Answer the user directly.',
  'Do not act as the coordinator unless explicitly asked.',
  'Do not create or re-plan the workspace task plan.',
].join('\n');
```

这样用户：

```text
@architect @security @engineer
```

不是：

```text
architect → security 看 architect → engineer 看前两人
```

而是：

```text
architect  ─┐
security   ─┼── independent responses
engineer   ─┘
                  ↓
            Lead / user synthesis
```

这是非常重要的变化。

---

# 二十二、Lead Prompt 必须从“多成员优先”改成“Single-Agent First”

`server/context-assembler.ts` 中的 `LEAD_INSTRUCTION` 修改。

当前：

```text
Assign each task to the Team Member whose capabilities and role best match the work.
Different tasks may be assigned to different Members and may run in parallel.
```

保留，但前面增加：

```text
MULTI-AGENT ROUTING:

Start with the smallest number of workers that can complete the work correctly.

Do not create multiple Members merely because different roles exist.

Prefer a single strong worker when the work is:
- sequential
- tightly coupled
- based on the same context
- difficult to split cleanly
- unlikely to benefit from independent verification

Use multiple workers when there is a real reason:
- independent parallel workstreams
- independent second opinion
- different data or authorization boundaries
- different tools or runtime capabilities
- context size requires separation
- long-running independent execution

Different personas are not a reason to create another task.
Different names are not a reason to create another task.
```

这个原则必须写进 Lead 的工作契约里。

Nature 2026 和 BenchAgent 的实验基本都在告诉你：不能再把“多 Agent”本身当成优化目标。([Nature][4])

---

# 二十三、`ask_member` 的定义也要改

`server/capabilities/providers/core-tools.ts`

当前：

```text
Ask another Team Member...
```

改成：

```text
Delegate a focused piece of work to another specialized worker.

Use this only when another worker has a materially different:
- responsibility
- capability
- knowledge scope
- tool set
- independent verification role

Do not use this merely to get another conversational opinion.
Do not delegate work that the current worker can complete directly.
```

这会显著减少：

```text
“Bob 你怎么看？”
“我问一下 Alice”
“再问一下 Security”
```

这种低价值 Agent Team 行为。

---

# 二十四、三个默认 Member 重新定义

## Architect

应该是：

```text
Role:
Architecture Planning

Capabilities:
architecture standards / business knowledge / research tools

Input:
requirements + constraints

Output:
architecture options + trade-offs + decision + risks
```

## Security

应该是：

```text
Role:
Independent Security Review

Capabilities:
security controls KB + security methods

Input:
architecture / implementation artifacts

Output:
threats + attack paths + missing controls + evidence + verification
```

关键：

```text
independentContext = true
```

## Engineer

应该是：

```text
Role:
Implementation

Capabilities:
repo + coding tools + tests

Input:
approved design + task

Output:
code + tests + build evidence
```

这样三个人的区别不再是：

```text
Architect personality
Security personality
Engineer personality
```

而是：

```text
different input
different context
different capabilities
different tools
different output
different responsibility
```

这才是研究真正支持的 Multi-Agent specialization。

JPMorgan 的 MAFA 生产系统就是这个方向：specialized agents + structured reasoning + judge/consensus，而不是人格模拟。([AAAI Publications][5])

---

# 二十五、`TaskOrchestrator` 不需要重写

这是一个需要“抓大放小”的地方。

`server/task-orchestrator.ts`

不用增加：

```text
MultiAgentOrchestrator
AgentTeamPlanner
PersonaCoordinator
AgentRouter
CollaborationManager
```

都不要加。

现有：

```text
Task dependency
↓
ready
↓
scheduler
↓
MemberRuntime
```

已经是正确基础设施。

研究证明 Multi-Agent 有用的地方，本来就应该落在 **Task decomposition + parallel execution**，不是再造一个“Multi-Agent 控制框架”。Anthropic 的生产 Research 和 C compiler 实验也是这么做的。([Anthropic][3])

---

# 二十六、不要现在新增 LLM Member Router

这一点我特别建议不要做。

现在不要增加：

```text
User question
    ↓
LLM Router
    ↓
Architect / Security / Engineer
```

理由是：

你的 Lead 已经承担：

```text
Goal understanding
Task planning
Task assignment
```

再增加一个：

```text
Agent Router
```

就是又多一个概率性决策层。

研究里的结论不是“需要更多 Router”，而是：

> 需要更好的任务分解与 adaptive workflow。

BenchAgent 甚至观察到，动态生成的 workflow 可以比固定的 Multi-Agent 拓扑更有效。([arXiv][6])

当前直接让 Lead 决定是否拆 Task 已经够了。

---

# 二十七、强烈建议加一个很小的评测框架

否则你以后很容易又回到：

> “感觉三个 Member 比一个 Member 更聪明。”

这个项目必须能回答：

```text
什么时候 Single Agent 更好？
什么时候 Multi-Agent 更好？
为什么？
多花了多少 token？
多花了多少时间？
多做了多少工具调用？
错误有没有增加？
```

## 新文件

```text
scripts/agent-strategy-eval.ts
docs/multi-agent-evaluation.md
```

不需要引入复杂 eval framework。

---

## 只做三类任务

### A. Decomposable

例如：

```text
对 10 家金融公司做基本面/风险/新闻研究
```

比较：

```text
single strong agent
vs
3 specialized workers
```

预期这是 Multi-Agent 最值得测试的类别。

---

### B. Independent Review

例如：

```text
Architect 设计 Agent 平台
Security 独立审查
```

比较：

```text
single agent self-review
vs
independent security worker
```

重点测：

```text
security findings
false negative
duplicate findings
```

---

### C. Sequential Coding

例如：

```text
修改 API
→ 改 DB
→ 改测试
→ 跑测试
→ 修 bug
```

比较：

```text
single strong engineer
vs
Architect → Engineer → Reviewer
```

这里很可能 Single-Agent 更划算。

Nature 对 SWE-bench/PlanCraft 的结果已经说明，高耦合、串行任务是 Multi-Agent 很容易吃亏的地方。([Nature][4])

---

# 二十八、评测指标只需要这些

不要再造几十个指标。

```text
success
quality
latency
input_tokens
output_tokens
tool_calls
rework
failed_executions
human_review_required
```

最终得到：

```text
             quality
                ↑
                │
      Multi     │
                │
                │
 Single ────────┼────────→ Cost
```

你的目标不是证明 Multi-Agent 更强。

目标是找到：

```text
什么时候应该 Single
什么时候应该 Multi
```

这比“我们的 AI Team 有三个专家”有价值很多。

---

# 二十九、增加 `independentContext` 的测试

## `server/test/task-service.test.ts`

增加：

```text
默认 independentContext = false
```

测试：

```text
plan_tasks 可以设置 true
add_task 可以设置 true
replan_tasks 可以设置 true
```

并验证只能 Lead 设置。

---

## `server/test/runtime-reliability.test.ts`

增加：

```text
independent task 不读取 shared conversation messages
```

以及：

```text
independent task 不推进 last_context_message_sequence
```

这个测试非常重要。

---

## `server/test/member-mention-routing.test.ts`

删除原来：

```text
previous member answer is injected
```

相关断言。

新增：

```text
Member A 的 mention response 不会作为 Member B
同一轮的默认输入
```

但仍允许：

```text
older user messages
structured task facts
knowledge
attachments
```

---

## `server/test/team-service.test.ts`

增加：

```text
delegate execution receives focused task context
and does not inherit arbitrary room transcript
```

---

## `server/test/schemas.test.ts`

增加：

```text
style 不再是 Member schema
independent_context 默认 false
```

---

## `server/test/member-template-seeder.test.ts`

确保：

```text
template 不再需要 style
```

并且默认三个模板正常 provision。

---

# 三十、`docs/prompt索引.md`

这个文件现在有明显的旧概念。

当前：

```text
身份与行为（persona / system prompt）
```

改：

```text
Member Identity & Work Contract
```

原：

```text
Security Reviewer 人设
Senior Software Engineer 人设
Solution Architect 人设
```

改：

```text
Security Reviewer Work Contract
Senior Software Engineer Work Contract
Solution Architect Work Contract
```

还有一个实际的路径错误需要一起修：

现在写：

```text
server/team-service.ts (`buildMemberSystemPrompt`)
```

当前实际代码已经在：

```text
server/execution-service.ts
```

所以直接修掉。

新增：

```text
Task independent context
Mention independence
Single-Agent-first routing
```

---

# 三十一、`docs/team-member-copilot-agent-architecture.md`

这篇非常值得改，但不要继续往里堆几十页理论。

核心只改几个地方。

## Member 定义

现在类似：

```text
Member = 长期 AI 同事
```

改成：

```text
Member = persistent specialized agent worker

Member provides:
- stable identity
- role/work contract
- model
- capability scope
- knowledge scope
- memory
- runtime session
- task ownership
```

然后加一句：

```text
Persona / personality affects presentation and interaction style,
but is not treated as a capability multiplier.
```

---

## 增加一个非常重要的原则

```text
### Member specialization rule

A separate Member is justified only when at least one is materially different:

1. data
2. tools
3. context
4. responsibility
5. output contract
6. execution lifecycle

Different names, personalities, or styles alone are not sufficient.
```

这比现在整篇关于“AI Team”的抽象描述更有实际意义。

---

## 把：

```text
Different Member = parallel
```

改成：

```text
Independent workstream = parallel

Same Member = serial

Different Member does NOT automatically imply parallelism.
```

这是研究结论直接映射到架构。

---

# 三十二、架构文档最后增加一条

放到最终原则附近：

```text
### Multi-Agent is an execution strategy, not a product requirement

Default:

Single strong Agent + Skills + MCP + Knowledge

Use multiple Agents only when decomposition creates a real benefit:

- parallelism
- specialization
- independent verification
- context isolation
- capability/data boundary
- long-running independent work

Do not create multiple Agents only to simulate a human team.
```

这条我建议最终保留下来，作为整个项目的核心原则之一。

---

# 三十三、`docs/拟人化agent member有帮助吗.md`

这个文件不要删。

它现在已经成为很有价值的研究记录。

但最后增加一个明确的：

```md
# Engineering Decision

本项目不再把 Persona / Soul 作为 Multi-Agent 的能力来源。

保留 Member / Team / Task / Runtime / Capability / Memory，
因为它们提供：

- work decomposition
- context isolation
- capability specialization
- independent review
- durable execution
- model routing
- auditability

删除 / 降级：

- Soul
- Personality
- Style as a separate capability
- serial peer-answer anchoring

新增：

- independentContext
- Single-Agent-first routing
- strategy evaluation
```

这样研究文档就直接对应代码，不再只是论文综述。

---

# 三十四、`README.md`

当前 README 有几个地方需要一起调整。

比如现在的：

```text
Member = long-lived AI participant with stable identity and memory
```

改：

```text
Member = long-lived specialized agent worker with stable identity,
work contract, capabilities, memory and runtime state.
```

当前：

```text
Member role + style + system prompt
```

改：

```text
Member role + work contract + model + capabilities + memory
```

当前模板：

```text
SYSTEM_PROMPT.md # 稳定行为与人格
```

改：

```text
SYSTEM_PROMPT.md # 工作契约与行为规则
```

当前：

```text
SQLite member ... 当前真实配置（人格字段）
```

改：

```text
SQLite member ... 当前真实 Member 配置
```

---

# 三十五、哪些东西我明确建议“不删”

这一部分很重要。不要因为研究证明 Persona 没那么重要，就把整个 Team 架构砍了。

## 不删 `Member`

因为它现在承担的是：

```text
identity
capability owner
memory owner
runtime owner
task assignee
audit subject
```

这些是真实业务对象。

---

## 不删 `MemberRuntime`

它提供：

```text
独立 Copilot Session
独立 workspace
独立 context checkpoint
execution lifecycle
```

这远远不是 Persona。

---

## 不删 `Task`

Task 才是 Multi-Agent 真正成立的基础。

```text
Lead
 ↓
Task
 ↓
Worker
 ↓
Execution
```

远比：

```text
Lead 问 Bob
Bob 问 Alice
Alice 再问 Bob
```

可靠。

---

## 不删 `Capabilities`

你当前真正有价值的东西之一就是：

```text
global
team
member

↓
effective capabilities

skill
knowledge
tool
MCP
```

这正是 specialization 的实际实现。

---

## 不删 Memory

Memory 和 Persona 是两回事。

Memory：

```text
长期事实
工作习惯
Team context
经验
```

可以保留。

只是不能把它叫做“灵魂”。

---

## 不删 `model`

不同任务用不同模型是非常有价值的成本/能力路由。

而且这比：

```text
Architect personality
Security personality
Engineer personality
```

更有实际收益。

Anthropic 自己的生产多 Agent Research 也是 Lead / Subagent 使用不同模型组合，而收益来自任务拆分和并行，不是人格本身。([Anthropic][3])

---

# 三十六、最终文件修改清单

## P0：现在就改

### 删除

```text
server/member-service.ts
  删除 writeSoul()

style:
  server/domain.ts
  server/routes/members.ts
  server/member-service.ts
  server/member-template-seeder.ts
  server/db-migrations.ts
  src/lib/api.ts
  src/components/team/MemberEditor.tsx
  src/components/team/NewMemberForm.tsx
  src/components/team/MemberProfile.tsx
```

模板删除：

```text
config/member-templates/*/member.json
  删除 style
```

删除 Mention anchoring：

```text
server/context-assembler.ts
  删除 previous mention response 注入
```

---

## P0：修改

```text
server/execution-service.ts
server/context-assembler.ts
server/member-template-seeder.ts
server/routes/members.ts
server/capabilities/providers/core-tools.ts
```

核心变化：

```text
Persona
  ↓
Work Contract

Multi-member chain
  ↓
Independent analysis

ask_member
  ↓
Focused delegation

Multi-Agent
  ↓
Single-Agent-first
```

---

## P1：增加

```text
server/domain.ts
server/db-migrations.ts
server/task-service.ts
server/task-application-service.ts
server/capabilities/providers/core-tools.ts
server/context-assembler.ts
```

加入：

```text
independentContext
```

---

## P1：测试

```text
server/test/member-mention-routing.test.ts
server/test/task-service.test.ts
server/test/runtime-reliability.test.ts
server/test/team-service.test.ts
server/test/member-template-seeder.test.ts
server/test/schemas.test.ts
```

---

## P1：文档

```text
README.md
docs/prompt索引.md
docs/team-member-copilot-agent-architecture.md
docs/拟人化agent member有帮助吗.md
```

---

## P2：评测

新增：

```text
scripts/agent-strategy-eval.ts
docs/multi-agent-evaluation.md
```

用于决定：

```text
single
vs
parallel multi-agent
vs
independent review
```

而不是再凭感觉加 Member。

---

# 三十七、改完以后，整个项目应该变成这个模型

```text
                         User
                           │
                           ▼
                    ┌─────────────┐
                    │    Lead     │
                    │ Goal/Plan   │
                    └──────┬──────┘
                           │
                 Single-Agent-first
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
      Architect         Engineer        Security
       Worker            Worker          Reviewer
          │                │                │
      own context      own context      independent
      own KB           coding tools     context
      own output       repo/test        security KB
          │                │                │
          └────────────────┼────────────────┘
                           ▼
                    Deterministic
                    Task/Execution
                    Orchestration
```

最关键的变化是：

```text
过去：

Member = 人格

现在：

Member =
  Identity
  + Role
  + Work Contract
  + Capability
  + Knowledge
  + Memory
  + Runtime
  + Task ownership
```

而：

```text
Persona / Style
```

不再被当成技术能力来源。

这与当前研究最吻合：Anthropic 的实际多 Agent 系统主要靠 parallel research、specialization 和 context partition；JPMorgan 的生产系统主要靠 specialized agents + structured reasoning + consensus；Nature 2026 和 BenchAgent 同时提醒你，很多任务上强 Single-Agent 反而更便宜、更稳定。([Anthropic][3])

当前仓库：[saga/team-member-copilot-agent](https://github.com/saga/team-member-copilot-agent?utm_source=chatgpt.com)

[1]: https://aclanthology.org/2024.findings-emnlp.888/?utm_source=chatgpt.com "When ”A Helpful Assistant” Is Not Really Helpful: Personas in System Prompts Do Not Improve Performances of Large Language Models - ACL Anthology"
[2]: https://proceedings.mlr.press/v235/du24e.html?utm_source=chatgpt.com "Improving Factuality and Reasoning in Language Models through Multiagent Debate"
[3]: https://www.anthropic.com/engineering/multi-agent-research-system?utm_source=chatgpt.com "How we built our multi-agent research system \ Anthropic"
[4]: https://www.nature.com/articles/s42256-026-01268-y?utm_source=chatgpt.com "Capable language models can outgrow the benefits of collaboration | Nature Machine Intelligence"
[5]: https://ojs.aaai.org/index.php/AAAI/article/view/41431?utm_source=chatgpt.com "MAFA: A Multi-Agent Framework for Enterprise-Scale Annotation with Configurable Task Adaptation | Proceedings of the AAAI Conference on Artificial Intelligence"
[6]: https://arxiv.org/abs/2606.05670?utm_source=chatgpt.com "Do More Agents Help? Controlled and Protocol-Aligned Evaluation of LLM Agent Workflows"

# Engineering Decision

本项目不再把 Persona / Soul 作为 Multi-Agent 的能力来源。

保留 Member / Team / Task / Runtime / Capability / Memory，
因为它们提供：

- work decomposition
- context isolation
- capability specialization
- independent review
- durable execution
- model routing
- auditability

删除 / 降级：

- Soul
- Personality
- Style as a separate capability
- serial peer-answer anchoring

新增：

- independentContext
- Single-Agent-first routing
- strategy evaluation
