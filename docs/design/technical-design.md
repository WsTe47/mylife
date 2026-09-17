# MyLife 技术方案

> 配套文档：[产品定义](./vision.md)（产品定义与竞争分析）、[路线图](./roadmap.md)（产品路线图）
>
> 本方案基于已在本机源码中核实的事实。标注：**【已验证】**= 读过本机源码或官方文档逐字确认；**【推断】**= 合理推断，未直接验证。

---

## 1. 形态与边界

### 1.1 结论

**MyLife 是一个 DSH 的垂直 profile + 一个 npm 插件包，不是一个独立 App。**

```
dsh --profile mylife
```

它做的事：在你的本地管理你输入过的所有个人情况文件，并基于它们做规划。
这话你的理解是准确的 —— 补充三点精确化：

| 你的表述 | 精确化 |
|---|---|
| "在我本地某个地方管理我输入过的所有文件" | ✅ 对。工作区目录 + 四层信息模型，全部是可读文本 |
| "基于这些对我做出进一步规划" | ✅ 对。但**规划能力来自 Skill（Markdown）**，不是硬编码的分支逻辑 |
| "有了这个插件就可以" | ⚠️ 插件提供**档案与机制**；具体某个领域（职业/旅游）好不好，取决于那个 Skill 写得好不好 |

**一句话：插件负责"让 AI 真正了解你"，Skill 负责"用这份了解做什么"。**

### 1.2 不在范围内的（明确划出去）

| 不做 | 交给谁 |
|---|---|
| 股票/基金推荐 | 社区 Skill。产品只提供**免责声明 + 事实数据**，不提供倾向 |
| 旅游/购物方案生成 | 外部 Skill / MCP |
| 账单爬取 | 有 MCP 就配，没有就用手填/导表（L1/L2） |
| 新的 Agent Runtime | DSH 本身 |
| 本地模型推理 | API（已定） |

---

## 2. 存储层：复用社区，不自建

### 2.1 官方支持这个做法

**【已验证】** DSH 官方文档有专门一节 **「连接第三方记忆 MCP 服务」**
（`guide/mcp-memory`），提供三份**默认关闭**的参考配置：

| 系统 | 传输 | 前置条件 |
|---|---|---|
| **Memorix** `@1.3.0` | stdio | Node 22.18+；**无需 LLM 或 embedding，可本地启发式运行** |
| **MCP Reference Memory** `@2026.7.4` | stdio | **本地知识图谱（实体/关系/观察）**，无需模型或 embedding |
| **Engram** `v1.20.0` | stdio | Go 1.25.10+ |

官方明确划了分工（原文）：

> **DSH 负责**：解析 overlay、启动已配置的 stdio 命令或连接 Streamable HTTP URL、
> 发现 MCP 工具、并以 `mcp__<serverName>__<tool>` 的形式公开这些工具。
> **DSH 不负责**：下载服务器、初始化其数据库、选择模型或 embedding 提供方、
> 创建云端账户、迁移提供方数据。

**安全细节【原文】**：stdio 桥接器在启动子进程前**会主动移除名字通常表示凭据的环境变量
和所有 `DSH_*` 变量**；其余环境变量仍会继承。密钥应写入配置项的 `config.env`，不要写进 YAML。

**已有实践样例**：`dsh-butler-memory`（[仓库](https://github.com/AndyYang12345/dsh-butler-memory)）
是"接一个记忆 MCP + 给 agent 工具 + 给用户面板"的完整形态。其面板包含
**记忆查看、敏感度徽章、修订时间线、推断候选可接受/拒绝**，并强调
"写入依然绑定 owner/revision/audit，**绝不静默入库**"。

> **这个面板设计对 MyLife 极有参考价值** —— 它正是"AI 推断必须经用户确认"的现成范式，
> 与我们的反谄媚设计同源。

**免责惯例【原文】**：官方对这三份配置注明"仅作为互操作参考；
**收录不代表 DeepSeek 的认可、推荐、合作关系或持续支持承诺**"。
MyLife 引用第三方项目时应沿用同样的措辞。

### 2.2 复用带来的架构分叉（必须先定）

如果 CLAIMS 层交给记忆 MCP，那么"带出处的证据图"就**不在工作区文件里**，
而在该 MCP 的数据库里。这直接影响 L0 与 L4 的落地方式：

| | **方案 A：文件为主** | **方案 B：复用记忆 MCP** |
|---|---|---|
| CLAIMS 存哪 | 工作区 `claims.yaml` | MCP 数据库 |
| 人可读 | ✅ 直接看/改/git | ➖ 需要面板或工具查看 |
| 可迁移 | ✅ 拷目录即可 | ⚠️ 依赖该 MCP 的导出能力 |
| 溯源链 L4 | 自建（指针 + hash） | 靠 MCP 的 observation/关系 |
| 语义检索 | ❌ 需自建 | ✅ 现成（Memorix 等） |
| 工程量 | 中（要写存储与检索） | 低（只写上层） |
| 风险 | 检索能力弱 | 数据被锁在第三方 schema 里 |

**建议：混合，且明确分层**

```
L0 原始层  →  工作区文件（永不外包）     ← 不可伪造的证据源必须在你自己手里
L0 检索    →  zvec-grep（实测中文语义检索有效，带 文件:行号）
L1 摘要层  →  工作区文件（可重新生成）
L2 证据图  →  Memorix（已接入）           ← 复用它的结构化存储与生命周期
L2 检索    →  ⚠️ Memorix 做不到中文检索，由 zvec-grep 承担
L3 档案层  →  工作区 YAML（带 TTL）        ← 时效逻辑是我们独有的
L4 溯源链  →  zvec-grep 提供 文件:行号 + 自建 claim→文件 指针
```

**理由**：L0 是"证据的最终真相"，绝不能被锁进第三方 schema；
L3 的 TTL 与失效逻辑是 MyLife 的核心，也不该外放；
只有 L2 这种"结构化事实 + 需要生命周期管理"的部分最适合复用。

> ⚠️ **重要实测结论：不要让 Memorix 负责中文检索。**
> 它的 BM25 不支持 CJK 分词（实测搜"跳槽"返回空），
> 而两个本地 embedding provider 的模型又是**硬编码的英文模型**（源码级确认）。
> 详见 [Memorix 接入实测](./research-memorix.md) 第 2、3 节。
>
> **接入状态**：Memorix 1.3.0 已装、profile patch 已写入并验证；
> 需要 git 仓库作为项目身份（`git init` 已执行于 `~/mylife`）。


**若采用方案 B 的一期最小路径**：先用
`Memorix`（无需 embedding，本地启发式）或 `MCP Reference Memory`（JSONL 知识图谱，零依赖）
跑通，避免一上来就引入向量库。

### 2.3 已确定的产品决定

| 项 | 决定 | 备注 |
|---|---|---|
| **工作区位置** | 默认 `~/mylife/`，**可配置** | 配置项，不硬编码 |
| **档案 git 化** | **可选**，引导用户开启 | ⚠️ **必须强提醒配置为私有仓库**（见下） |
| **字段词典** | **不预制**。用户聊什么就建什么 | 空词典起步，按需生长 |
| **分支默认行为** | **询问**，可配置 | 记住用户偏好 |
| **L1 摘要原文保留** | **可配置**（默认保存） | 见 2.4 |
| **UI** | 现有 Web 页面即可，不自建 | 一期不做自定义面板 |

#### 关于 git 化的隐私强提醒（不可省略）

档案里会有月收入、贷款、心理状态、职业不满。**误推到公开仓库是不可逆的泄露。**

设计要求：
1. 开启 git 时**默认做私有仓库检查**，检测不到私有性就**拒绝自动推送**。
2. 首次 `remote add` 时给出显式确认，文案必须说清后果。
3. 提供 `.gitignore` 模板，默认忽略 `raw/` 之外的敏感派生文件（可选）。
4. README 与设置页都要写："**请务必使用私有仓库**"。

#### 关于字段词典不预制的推论

你说得对，**预制词典会把产品框死**。这条决定有个重要推论：

> **时效性（TTL）不能依赖预制词典，必须由系统在"创建字段时"当场推断。**

即：当用户第一次提到"房租 4500"，系统创建字段时**同时推断它的 TTL**
（房租 → 一年；存款 → 三个月；学历 → 不过期），并向用户确认一次。
这样既保持开放，又不丢掉时效能力。

### 2.4 一个仍未决定的项（需要你确认）

**L1 摘要层是否要同时保留"AI 原始输出"与"用户修订版"？**

- **保留两者**：好处是能发现"AI 的转述和你的本意有偏差"，且这个偏差本身就是有价值的信号；
  坏处是文件更多、可能混淆。
- **只留一版**：简单，但丢失了"误解的历史"。

我的建议：**保留两者，并对差异做标注**。因为"AI 误解了你"这件事，
恰恰是校准系统的原料 —— 也符合本产品"可反驳"的核心设计。

→ 这一条我打算做成**配置项，默认保留两者**。如果你同意，我就按这个建。

---

## 3. 信息模型（核心）

### 3.1 设计出发点

你的核心论点是：**使用者最该做的事，是让 AI 真实地了解自己**；而人无法在繁杂信息中综合判断，所以需要把繁杂输入交给 AI 汇总。

这推出一个架构结论：

> **信息维护不是产品的附属功能，而是产品的中心。**
> 因此信息模型必须**首先服务于"可维护性"和"可溯源"**，其次才服务于检索。

### 3.2 四层结构

```
<workspace>/mylife/
├── raw/                    # L0 原始层：永不修改，永不删除
│   ├── 2026-01-15-career.md
│   └── 2026-01-20-finance-notes.md
├── digest/                 # L1 摘要层：LLM 整理过的可复用表述
│   └── topic-career.md
├── claims/                 # L2 结构层：机器可查的证据图
│   └── claims.yaml
├── profile.yaml            # L3 档案层：当前状态 + 时效
└── index.yaml              # L4 索引层：结论 → 依据 → 原文 的反查链
```

#### L0 原始层 —— 一字不改

**你的原话：** "即使它是一段包含了错别字的文字内容，这条原始信息一定是要保留的。"

- 原始输入**只增不改不删**。错别字、语病、情绪化的重复都保留。
- 文件名带日期。可以是语音转写、粘贴的长文、手打碎片。
- **为什么重要**：L0 是唯一不可伪造的证据源。当 AI 说"你曾表示 X"，你要求溯源时，看到的必须是**你自己写的原话**，而不是 AI 的转述。没有 L0，"锚定证据"就是一句空话。

#### L1 摘要层 —— 为复用而整理

- 按**主题**整理（不是按时间），目标是让 agent 下次不必重读 L0。
- 保留：核心表述、时间、当时的语境。
- 可重新生成：L0 在，L1 随时可以重做。所以 L1 不是真相，是缓存。

#### L2 结构层 —— 证据图

每条证据一个记录：

```yaml
# claims/claims.yaml
- id: claim-2026-01-15-003
  topic: 职业去留                    # 主题聚簇键
  claim: 我无法忍受当前的管理方式
  kind: fact | assessment | inference  # 事实 / 主观评估 / AI推断
  source: user_raw | user_filled | bill_import | mcp | llm_inferred
  provenance: "raw/2026-01-15-career.md#L42"
  occurred_at: 2026-01-15
  context: 连续加班三周
  confidence: high
  status: active | stale | superseded | disputed
  superseded_by: null
```

**关于 `kind` 三分（你要求区分事实/推断/人工输入/LLM建议）：**

| kind | 含义 | 决策时的权重 |
|---|---|---|
| `fact` | 客观上可核验的（学历、月收入、工龄） | 高 |
| `assessment` | 用户的主观评估（"我觉得没成长"） | 高——**这是用户的真实感受，不能当噪声丢掉** |
| `inference` | AI 的推断（"你可能更看重稳定性"） | **低，必须显式标注，且用户可否决** |

关键原则：**`assessment` 不是二等公民。** 你说"大厂经历能否洗刷学历的平庸""加班到什么程度值得放弃现有生活"——这些都是 `assessment`，而它们恰恰是决策的真正难点。AI 不该用"客观数据"去压扁它们。

#### L3 档案层 —— 当前状态 + 时效

`profile.yaml` 记录**可过期的字段**（这是"信息维护"的数据基础）：

```yaml
fields:
  月税后收入:
    value: 18000
    source: user_filled
    updated_at: 2026-01-10
    ttl_days: 180                 # 半年后自动标 stale
  房租月支出:
    value: 4500
    source: user_filled
    updated_at: 2025-08-01
    ttl_days: 365
  现有存款:
    value: 120000
    source: user_filled
    updated_at: 2026-01-10
    ttl_days: 90                  # 存款变化快
  学历:
    value: 普通本科
    source: user_filled
    updated_at: 2026-01-10
    ttl_days: null                # 不过期
```

**TTL 是逐字段的，不是一个全局阈值。** 学历不失效，收入每月都可能变。

#### L4 索引层 —— 反查链

**你的原话：** "这个可以当成多层级的索引来一级级地能反查出来依据来源。"

```
结论（AI 输出的某句话）
  └─→ L2 claim id
        └─→ L1 digest 段落
              └─→ L0 原始文件 + 行号
```

规则：**任何对外输出的判断，都必须能在 L4 里落成一条链。落不成的判断不许输出。**

这条规则是"反谄媚"的技术实现方式 —— 不是靠提示词祈祷模型诚实，而是**让"没有依据就说"这件事在结构上无法完成**。

### 3.3 Store 只存指针，不存副本

**【推断，但强烈建议】**

L2/L3/L4 里的 `value` 建议**只存指针 + 元数据**，不复制原文内容：

```yaml
- id: claim-2026-01-15-003
  provenance: "raw/2026-01-15-career.md#L42"    # 指针
  excerpt_hash: "sha256:ab12..."                 # 校验原文未变
```

好处：原文改了能被发现（hash 不匹配 → 提示"依据已变更，需重新评估"）；
且不会出现"档案里的转述和原文不一致却无人察觉"。

---

## 4. 时效与信息维护机制

### 4.1 触发时机（你要求的"首先提醒用户确认信息"）

```python
def check_staleness(topic) -> list[BlockingField]:
    """决策前调用：找出这个决策依赖的、且已过期的字段。"""
```

流程：

```
用户问："我该不该跳槽？"
  ↓
1. 决策依赖图：跳槽决策依赖 [月收入, 现有存款, 房租, 房贷, 工作年限, 学历, 加班强度, 对当前工作的评估...]
  ↓
2. 逐字段检查 updated_at + ttl_days
  ↓
3. 若发现 [现有存款(已过期87天), 房租(已过期120天)]
  ↓
4. 不是"拒绝回答"，而是：
   "回答这个问题我需要两个可能已经变了的数字：
      现有存款（你上次填是 3 个月前）
      房租（你上次填是去年 8 月）
    这两个数字会直接影响结论 —— 如果存款增加较多，你承受空窗期的能力就不一样。
    [现在更新] / [沿用旧值，但结论会标注不确定]"
```

**关键设计：给"沿用"这个选项。** 否则用户被卡住会烦。
若用户选沿用，输出里该结论强制标注"基于可能过时的 X（Y 个月前的数据）"，并降权。

### 4.2 定时维护（你划到二期，我认可）

一期不做，但**数据模型要预留**，否则二期要重构：

- 每个字段的 `updated_at` / `ttl_days` 就是为定时巡检准备的。
- 二期加一个 `mylife-maintenance` 能力：定期列出"最久未确认的 N 个字段"并提醒。
- 复用第 6 节的调度机制（launchd + headless + IM 推送）。

### 4.3 字段字典

时效规则依赖**字段词典**（有哪些字段、各自的 TTL、被哪些决策依赖）：

```
skills/mylife-profile/
└── fields.yaml       # 字段定义：名称、TTL、所属主题、依赖它的决策
```

**这是可扩展点**：社区可以贡献新的字段定义（比如"健身频率""睡眠时长"），
而不需要改插件代码。这符合"领域交给社区"的分工。

---

## 5. 反证与话题漂移（本方案最关键的设计）

### 5.1 反证引擎

**你已认同的定义**：不是"冲突检测"，而是**主题聚簇 + 时间戳 + 语境还原 + 提问式收尾**。

输出形态（三段式，不可省略）：

```markdown
## 你在「职业去留」上的多段表述
| 时间 | 表述 | 当时的语境 |
|---|---|---|
| 2025-11 | "热爱这里，绝不想走" | 刚完成一个重要项目 |
| 2026-01 | "想跳槽" | 连续加班三周 |
| 2026-03 | "不知道" | 刚被调岗 |

这三段是否指向同一个事实 —— 你认可工作内容但不认可当前强度？
如果是，真正要解的问题就不是"走不走"，而是"强度能否改变"。

## 待作废的旧前提
"财务压力大"（2025-06 提及）—— 按你最新数据，结余已改善。还成立吗？
```

**注意最后一段是提问，不是结论。** 这是"还原"和"指控"的分界线。

### 5.2 话题漂移：问题定义

**你描述的场景非常真实：**

> 聊跳槽 → AI 引用财务信息反驳 → 我意识到财务才是当前更痛的点 → 话题转到财务 → 聊完想回到跳槽 → **但 Context window 可能已经让 AI 漂移了重点**

这个问题的本质是：**用户的话题树是分叉的，但对话是线性的。** 分叉一旦发生，回到主干时主干已经被压缩/遗忘了。

### 5.3 解决机制

#### (a) 漂移检测信号

| 信号 | 如何检测 | 可信度 |
|---|---|---|
| 显式切换 | 用户消息里的切换标记（"说回""先不管这个""另外"） | 高 |
| 语义距离 | 新消息与当前主干主题的语义距离超阈值 | 中 |
| 引入新的依赖领域 | 新话题依赖一组完全不同的档案字段 | 高 —— **这是最可靠的信号** |
| 上下文压力 | 上下文占用率 + 分支话题轮次 | 中 |

**第四种最值得投资**：跳槽依赖[职业字段]，财务依赖[财务字段]，两者字段集几乎不重叠 —— 这本身就是"这是一个新主题"的强证据，不需要靠模型猜。

#### (b) 主动提供分支选项

**你要求的"提醒他去创建"，实现方式是在检测到漂移时明确给出选择：**

```
我注意到我们从「职业去留」聊到了「财务压力」，
而财务可能是你现在更想解决的。

这段对话继续下去，「职业去留」那条线可能会因为上下文变长而丢细节。

  [就在这里继续聊财务]（简单，但原话题会变模糊）
  [把财务拆成一个子话题去聊]（结束时会带回一份结论，原话题保留）

建议拆出去 —— 财务依赖的是另一组数据，独立聊会更清楚。
```

**注意措辞**：不是"要不要开子 Agent"（用户不懂这是什么），而是
**"要不要拆出去聊，结束时会带回结论"**（用户听得懂的价值）。

#### (c) 子 Agent 的实现机制

**【已验证】** DSH 的 `subagent_fork` 能力：**子 Agent 继承当前对话的完整上下文**。
另有 `subagent`（全新上下文，不带对话）。

| 用哪个 | 场景 |
|---|---|
| `subagent_fork` | **默认选这个**。子话题需要"我们刚才聊了什么"作为背景 |
| `subagent` | 子话题完全独立（如"帮我查一下这个行业数据"） |

分支流程：

```
1. 父会话：确认用户选择"拆出去"
2. 记录分支意图：topic=财务压力, parent_topic=职业去留, 待回收=true
3. subagent_fork 子 Agent 执行：
   - 入参：本次要解决的问题（聚焦、单一）
   - 完整上下文：继承，所以它知道跳槽那条线
   - 产出：结构化结论（不是聊天记录）
4. 结论写回 L2/L3（作为新证据）
5. 回到父会话，父 Agent：
   - 收到子结论摘要
   - 检查是否与现有 claim 冲突 → 冲突就质询
   - 主动拉回主干："我们之前停在「跳槽」，刚聊出来的结论改变了 X，要不要重新看那个问题？"
```

**第 5 步的最后一句是防漂移的关键。** 没有它，用户还是会忘记原来的主线。

#### (d) 分支的持久化

分支不能只活在内存里 —— 会话重启就丢了。所以：

```yaml
# index.yaml 里的分支记录
branches:
  - id: br-2026-03-01-01
    topic: 财务压力
    parent_topic: 职业去留
    status: open | merged | abandoned
    opened_at: 2026-03-01
    conclusion_ref: claims/claims.yaml#claim-2026-03-01-011
```

`status: open` 的分支会在下次进入相关话题时被提示："你上次把财务压力拆出去聊了，结论是 X，现在要回到跳槽那个问题吗？"

#### (e) 子 Agent 产出的交接格式

子 Agent 不返回聊天记录，返回**结构化交接单**（这是它和父会话之间唯一的接口）：

```yaml
topic: 财务压力
question_answered: 我现在的现金流能不能支撑 3 个月空窗期
conclusion: 能，但需把月支出压到 12000 以下
new_claims_added: [claim-2026-03-01-011, claim-2026-03-01-012]
changed_fields: [现有存款, 月支出估计]
competing_evidence:                        # 必须填：削弱这个结论的证据
  - "你 2025-06 提到有未结清的信用卡分期，金额未确认，若超过 2 万则结论不成立"
open_questions:
  - 信用卡分期的确切余额
impact_on_parent_topic: "空窗期可行性提高，'裸辞'这个选项的权重上升"
```

**`competing_evidence` 和 `impact_on_parent_topic` 是必填字段。**
这正是把"强制反证"下沉到架构层，而不是留给提示词。

---

## 6. 架构与服务

### 6.1 包结构

```
dsh-mylife/
├── package.json                 # engines.dsh + dsh.bundle + dsh.client
├── cordis.patch.yml             # insert 行（必须带 id）
├── src/
│   ├── index.js                 # 宿主入口：apply(ctx) 装配各模块
│   ├── store/                   # 四层读写 + 溯源链
│   ├── staleness/               # 时效检查 + 字段词典
│   ├── evidence/                # 反证（聚合、还原、质询）
│   ├── drift/                   # 漂移检测 + 分支管理
│   ├── tools/                   # 面向模型的工具
│   └── client/                  # 浏览器侧 UI
└── skills/                      # 随包分发的默认 Skill
    ├── mylife-profile/          # 档案维护与时效确认
    ├── mylife-career/           # 职业透镜
    └── mylife-finance/          # 财务透镜（现金流/消费流，不含投资建议）
```

### 6.2 能力声明与注入

```js
// src/index.js
export const name = 'mylife'
export const inject = ['fs', 'tools', 'agents', 'sessions', 'skills']  // 【推断】按实际服务名调整
```

**注意【已验证】的事实**：

- `ctx.fs` **存在**（`FileSystem` abstract seam，声明包 `packages/fs/fs`，本机实现 `dsh-fs-local`）。
- 但**给模型用的文件能力是工具**（`dsh-tool-fs` 的 `read`/`write`/`edit`），两者不是一回事。
  → **结论：插件内部读写档案用 `ctx.fs`；给模型操作档案的能力用注册工具。**
- 服务名清单不要自己维护：以各 `docs/subsystems/*.zh.md` 的 `GENERATED cordis-surface` 区块为准（共 82 个 `ctx.<key>`）。

### 6.3 工具清单（面向模型）

| 工具名 | 作用 |
|---|---|
| `mylife_record` | 把一段输入存入 L0 原始层，返回 id |
| `mylife_digest` | 生成/更新某主题的 L1 摘要 |
| `mylife_claim_add` | 新增 L2 证据（自动抽取 kind/source/provenance） |
| `mylife_recall` | 按主题或关键词取回 L1/L2 |
| `mylife_trace` | 给一个 claim id，反查回 L0 原文（L4 溯源） |
| `mylife_staleness` | 给定决策主题，返回阻塞性的过期字段 |
| `mylife_competing` | 给定一个拟输出的结论，检索削弱/相反的已有证据 |
| `mylife_branch` | 开启一个话题分支（内部走 subagent_fork） |
| `mylife_profile_update` | 更新 L3 字段（含 source 与 updated_at） |

命名说明【已验证】：避免保留名 `run_code`；同层重名会失败；第一方风格是 snake_case。

### 6.4 钩子（强制机制，不靠提示词）

**(a) `tools/pre-execute` —— 决策前拦一道**

```js
ctx.on('tools/pre-execute', async (exec, next) => {
  // 若正在执行的是产出决策的工具/最终回答
  const stale = await checkStaleness(exec)
  if (stale.length) {
    return { kind: 'steer', reason: `依赖字段已过期：${stale.join(', ')}，需先请用户确认` }
  }
  return next()
})
```

**【已验证】** `tools/pre-execute` 是 waterfall，可返回类型化决策（allow/deny/steer），
沙箱、权限、plan-mode 插件用的就是这个扩展点。需要单调最终拒绝时用 `ctx.tools.guard()`。

**(b) `session/event` —— 漂移检测**

```js
// 【已验证】注意：turn/*、step/*、tool/call 是"会话事件类型"，不是 Cordis 事件。
// 要监听它们必须走 session/event 并检查 event.type。
ctx.on('session/event', (session, event) => {
  if (event.type === 'assistant/message') { /* 累积；到达边界时评估漂移 */ }
})
```

**(c) 输出前反证（软约束 + 结构校验）**

在 Skill 里定义强制输出模板；同时用一次 `mylife_competing` 调用让"没查反证"这件事可被发现。

**设计原则：能用结构解决的，不要用提示词解决。**
提示词会被更长的新指令挤掉；结构校验不会。

### 6.5 浏览器侧

**【已验证】** 真实样板见 `~/.dsh/profiles/web/node_modules/@climber47/dsh-step-clock/`
（`dsh.client` 声明 + `lib/client.js`，React 18 peer）。

要加的 UI：

| 位置 | 内容 |
|---|---|
| 独立面板 | **"我现在的状态"**：当前主干话题、开放分支、过期字段、最近变化 |
| 输入框状态条 | 当前是否处于分支中；过期字段计数 |
| 侧边栏 | 档案文件浏览与编辑入口 |
| 设置卡片 | 字段词典、TTL 配置、Skill 开关 |

**注意【已验证】的坑**：`dsh.client.inject` 是 **informational only**（官方注释原文
"Informational package-name dependencies, not Cordis service injection"），
**不决定加载顺序**。别指望往里面写包名来排依赖。

### 6.6 Skill 的加载前提（重要）

**【已验证】** `dsh-web-app/cordis.patch.yml` 把宿主层的 `skill-filesystem` 与 `tool-skill`
两行设为 `disabled: true`（第 402–406 行），**改由 agent preset 挂载**；
`standard/agent.cordis.yml` 第 84–88 行挂载了这两行。

> **含义：你把 `SKILL.md` 放对位置 ≠ 一定生效。必须先确认当前 agent preset 挂了这两行。**
> 换 preset 可能让所有 Skill 静默消失 —— 这是调试时的第一检查项。

**扫描根与优先级【已验证】**：

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `~/.dsh/skills` |
| 500 | user-agents | `~/.agents/skills` |
| 600 | bundled | `Config.bundledSkillDir` |

格式：`<root>/<kebab-name>/SKILL.md` 或 `<root>/<kebab-name>.md`。
**不支持嵌套 `**/SKILL.md`**。必填 frontmatter `name` + `description`。
改名/新增**无需重启**即可生效（watcher）。

### 6.7 调度（二期）

**【已验证】** `dsh-schedule` 的硬限制（原文）：

> "Reminders survive restarts, but delivery requires a live root agent:
> closed sessions keep reminders overdue until resumed."

→ **"三个月后提醒我"不能用它。** 正确链路：

```
macOS launchd（或 cron）
  → dsh --profile mylife --profile headless "执行档案维持巡检"
  → 结果投递（本机已有 @xmanrui/dsh-im + 飞书 MCP，可推到手机）
```

**【已验证】** 另注意：`patchReload: live` **只重载配置层，不替换源码模块**；
改插件源码要生效需显式启用模块 HMR（`dsh-base` 的 `hmr` 行默认 `disabled: true`）。

---

## 7. 分发

> 完整的发布清单与社区贡献策略见 [发布与社区贡献](./release.md)。本节给结论。

### 7.0 两个渠道，性质不同

**关键更正：官方 README 推荐的是 GitHub 话题标签，不是 awesome-dsh-plugin。**

**【已验证】** 官方 README 的 "Community and support" 章节原文（共三条）：

```
- Submit feedback or bug reports through GitHub Discussions.
- Add the [dsh-plugin](https://github.com/topics/dsh-plugin) topic to your
  plugin repository for discoverability.
- Join the DeepSeek Harness Discord community.
```

| | A. 官方话题 | B. awesome-dsh-plugin → dsh-market |
|---|---|---|
| 谁推荐 | **官方 README 明确推荐** | 社区自发 |
| 门槛 | 无，加标签即可 | 有审核 |
| 用户发现 | GitHub 搜 topic | DSH 内 Plugin Market，一键安装 |

**两个都要做**：A 零成本、仓库一公开就加；B 需要发布 npm 包 + 提 PR。

### 7.1 有没有官方应用市场？

**没有官方的。市场是社区的，而且这个"没有官方"是刻意的。**

`deepseek-ai` 官方组织内**没有任何** registry / market 仓库，官方 README 也从未提及 dsh-market。
这与 "Everything is a Plugin" 的哲学一致 —— 连市场本身都是社区插件。

**对 MyLife 的意义：生态门槛低、开放。**
harness 本体 ~22.7 万星，awesome 列表 ~1.6 万星，dsh-market ~4 千星 → **目录层远未饱和。**

**【已验证】** 你机器上已经装了 `dshmarket`（Settings → Plugin Market），
它现在读的目录源是：

```
https://awesome-dsh-plugin.com/plugins.json
```

**【已验证】** `dshmarket` README 原文：

> "**This repo is the market app, not the catalog.** The plugin list comes from the curated
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry —
> to get your plugin listed in the market, open a PR **there**（一条列表项；站点与市场会自动同步，
> 通常一天内）。Please don't PR plugin entries against this repo."

并且 **`dshmarket` 明确读的是顶层 `engines.dsh`**
（`lib/discovery-compatibility.js` 第 38/50 行：`record(manifest.engines)` → `engines?.dsh`）。

→ **这印证了之前的勘误：兼容性字段写顶层 `engines.dsh`，而 `dshmarket` 正是靠它判断兼容性的。**

国内网络还有个细节：市场默认 region 是 china（你的 `.dsh-market/state.json` 里 `region: "china"`），
必要时可用 `DSHM_REGISTRY_URL=<镜像>` 指向自有镜像。

### 7.2 发布路径（三处，缺一不可）

| 步骤 | 做什么 | 目的 |
|---|---|---|
| 1 | 给仓库加 `dsh-plugin` topic | **官方 README 推荐的发现路径**，零成本 |
| 2 | 发布 npm 包 `dsh-mylife`（顶层 `engines.dsh` 必写） | 安装源 |
| 3 | 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR（`data/plugins/<owner>__<repo>.yml` **一个文件**） | 进 dsh-market 目录 |

**【已验证】** 渠道 3 的坑：**"Most rejected submissions declare only `dsh.client`"** ——
必须在 `package.json` 声明 `dsh.bundle.patch`，否则不可安装。
详见 [发布与社区贡献](./release.md) 第 2.3 节。

**用户侧安装体验（这就是"上架在哪"的答案）：**

```
Settings → Plugin Market → 搜索 "mylife" → 一键安装
```
或命令行：
```sh
dsh plugin --profile web add dsh-mylife
```

### 7.3 命名与合规

- `dsh-` 前缀**非强制**（【已验证】：`dshmarket` 这类包也没有），但社区惯例是加。
- npm 包名 + 仓库名 + README 里都必须有**免责声明**（见 6.4）。
- **不要**在包描述或关键词里出现"投资建议""理财推荐"等字样 —— 避免落进持牌业务的语义范围。

### 7.4 免责声明（必须出现在 README 顶部与每次决策输出末尾）

> MyLife 是决策支持与自我认知工具。输出由大语言模型生成，**仅供参考**，
> 不构成投资、法律、税务、医疗或心理健康建议。
> 涉及投资、医疗、心理危机等专业领域，请咨询相应持证专业人士。
> 你的数据保存在本地；启用云端模型时，用于推理的内容会发送至你所配置的 API 提供方。

---

## 8. 关键设计决策速查

| 决策 | 选择 | 理由 |
|---|---|---|
| 形态 | DSH profile + npm 插件 | 不重造 runtime |
| 推理 | API，非本地模型 | 成本 |
| **存储层** | **复用社区记忆 MCP（L2 外包），L0/L3 自持** | 官方支持；不重复造轮子 |
| 数据 | L0/L1/L3 本地纯文本 | 可读、可 git、可迁移、可溯源 |
| **工作区** | 默认 `~/mylife/`，**可配置** | 不硬编码 |
| **git 化** | 可选 + **强制私有仓库提醒** | 泄露不可逆 |
| **字段词典** | **不预制**，按需生长；TTL 建字段时当场推断 | 预制会把产品框死 |
| 规划能力 | Skill（Markdown） | 领域交给社区，无需改代码 |
| 反谄媚 | **结构校验优先，提示词兜底** | 提示词会被挤掉 |
| 溯源 | L4 反查链强制落地 | 无链不许输出 |
| 时效 | 逐字段 TTL | 学历不失效，收入每月变 |
| 漂移 | 字段集不重叠作为主信号 | 比语义猜测可靠 |
| 分支 | `subagent_fork`（继承上下文），默认**询问** | 【已验证】能力存在 |
| 长周期提醒 | launchd + headless + IM | `dsh-schedule` 无法脱离进程 |
| 一期 UI | 现有 Web 页面，不自建 | 先跑通机制 |
| 分发 | 官方话题标签 + npm + awesome-dsh-plugin PR | 【已验证】两个并存渠道 |

---

## 9. 待确认事项

前 5 项已决定（见 2.3）。仅剩 1 项待你确认：

1. **L1 摘要层是否同时保留"AI 原始输出"与"用户修订版"？**
   （我在 2.4 节建议：**保留两者并标注差异**，且做成配置项默认开启。
   理由：能发现"AI 转述与你的本意有偏差"，而这个偏差正是校准系统的原料。）

