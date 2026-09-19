# MyLife

> **从混乱中找出你的主线，并且记得它在时间里的变化。**
> **Your data stays home. Your thinking gets organized.**

**文档索引**

| 文档 | 内容 |
|---|---|
| **VISION.md**（本文） | 产品定义、核心洞察、边界与风险、竞品对比 |
| [技术方案](./technical-design.md) | 四层信息模型、反证引擎、话题漂移与子 Agent 分支、包结构与工具清单、分发 |
| [路线图](./roadmap.md) | 四阶段路线图、成败判据、"越用越离不开即失败"的判据 |
| [发布与社区贡献](./release.md) | 发布与社区贡献：官方话题标签、awesome-dsh-plugin 收录要求、就绪清单 |

---

## 0. 这份文档是什么

本文档记录 MyLife 从"一个模糊的生活助手设想"收敛到"一个可执行的产品定义与技术路线"的完整过程。
内容分三部分：

- **第一部分｜产品**：定义、核心洞察、边界与风险（第 1–4 章）
- **第二部分｜竞争**：竞品对比与空白定位（第 5 章）
- **第三部分｜实现**：基于 DeepSeek Harness 的技术路线与落地步骤（第 6–10 章）

标注约定：**【已验证】**= 已在本机源码或官方文档中逐字确认；**【推断】**= 基于已知信息的合理推断，未直接验证。

---

# 第一部分｜产品

## 1. 一句话定义

> **MyLife 是一个本地优先的「个人状态库 + 决策引擎 + 主动复盘器」：它持续维护一份关于你的、带出处和时间戳的状态档案；当你要做决定时，它从混乱里抽出主线、强制找出反证、给出带证据的路径；并在你设定的时间点主动回来问你"结论还成立吗"。**

### 它不是什么

| 不是 | 原因 |
|---|---|
| 生活助手大礼包（旅游+购物+财务+职业功能并列） | All-in-one 效率 App 全都死了，每一项都打不过专精工具 |
| 又一个 Agent Runtime | 无意义的重造。DSH 已经是，直接站上去 |
| 旅游规划器 / 购物推荐器 / 记账 App | 这些是**下游领域实例**，应由外部 Skill & MCP 提供 |
| 聊天机器人 | 聊天只是入口之一，中心是"你现在的状态"和"待你确认的变化" |

## 2. 核心洞察（产品的全部价值在这里）

灵感来源是一次真实的自救：深夜失眠、对未来迷茫，用语音输入 + 飞书文档写了一篇约 14000 字的碎碎念，耗时 1 小时。写完之后自己都知道"说不清到底该怎么办"。次日让 AI 总结，结果**"非常精准地命中了我心中所想"**。

关键在于：**信息 100% 是用户自己提供的**。所以价值不在"AI 知道你不知道的事"，而在于：

| 人的大脑做不到 | LLM 做得到 |
|---|---|
| 同时持有 14000 字的上下文 | 全文同时在场 |
| 从情绪化碎片里抽出因果链 | 把"我烦这个"还原成"我在 X 和 Y 之间无法取舍" |
| 指出你话里的自相矛盾 | 你说了 A 也说 ¬A，它能同时贴出来 |
| 把模糊感受转成可执行动作 | 输出有主次、有验收条件的路径 |
| 记住你一年前的约束还在不在 | 时间戳 + 出处 + 时效判定 |

**结论：这是一个「外置的思维组织器」（external thinking organizer）。**
生活管家是帮你干活，组织器是帮你**想清楚**。两者产品形态完全不同：管家要很多集成，组织器只要"输入足够真、输出足够准"。

### 技术自信要放在哪

宣言 `Everything use LLM` 是**技术手段**，不是**用户价值**。没有人因为"你用了 LLM"而使用它。
它更适合放 README 的技术章节，而不是标语。

## 3. 三层架构

| 层 | 内容 | 谁提供 | 备注 |
|---|---|---|---|
| **采集层** | 语音 / 文字 / 文档 / 账单，**永不要求用户先整理** | 本项目 | 入口价值所在 |
| **认知层** | 主线抽取 + **状态档案（带出处+时间戳）** + **反证库** | 本项目 | 核心 |
| **时间层** | **主动复盘** + **冲突质询** + **跨域重算** + **旧前提作废** | 本项目 | 核心·差异化 |
| **领域层** | 职业 / 财务 / 旅游 / 购物 / 健康 | 外部 Skill & MCP | 社区做得更好 |

### 3.1 认知层详细

把混乱变成结构化认知，输出四类东西：

1. **核心议题**：你到底在纠结哪一个取舍。
   不是"你很焦虑"，而是"你在稳定性与成长性之间无法取舍"。
2. **事实 / 推断 / 未知 / 矛盾** 四分类，尤其要把"你说了 A 又说了 ¬A"摊开。
3. **状态档案**（结构化、带时间戳、带出处、带置信度）——这是"长期助手"与"一次性咨询"的分界。
4. **价值观与约束**：你反复强调什么、真正无法接受什么。
   **每一次建议最终都要能对回这一层，否则就是通用废话。**

### 3.2 时间层详细（最有价值的部分）

三个机制，共同构成护城河：

**(a) 主动复盘**
到预设时间点主动回来问"上次的结论还成立吗"。
注意：**不要靠用户主动回来**。产品主动制造事件。

**(b) 反证引擎 —— 但它不是"冲突检测"**

这是最容易做歪的地方。**"我想跳槽"和"我热爱这里"往往不矛盾，而是同一个人的两面。**
真相多半是"我热爱我的同事和做的事，但无法忍受这个管理层"——两句同时为真。
如果 AI 跑去说"你上次说的和这次不一样！"，用户的感受是**被抓住把柄**，而不是**被理解**。产品会显得很烦人。

正确做法：

1. 证据按**主题**聚簇（职业去留、财务安全感、对某人的评价……），不是按时间平铺。
2. 每条证据带时间戳 + **当时的语境**（当时发生了什么）。
3. 冲突出现时，输出**还原**而非**指控**：
   > "关于去留，你有三段表述：2025-11 说'热爱这里绝不走'（刚完成一个项目）；2026-01 说'想跳槽'（连续加班三周）；本周说'不知道'。**这三段是否指向同一个事实——你认可工作内容但不认可当前强度？** 如果是，真正要解的问题就不是'走不走'，而是'强度能否改变'。"

**(c) 旧前提作废（最被低估的功能）**

> "你 8 个月前提到财务压力大，但按你最新填的数据，现在结余已改善——这条约束还成立吗？"

**人的旧约束会自动在心里失效，但 AI 会一直记着。**
主动作废旧前提，比找出矛盾更有价值——因为不这么做，AI 会拿一年前的恐惧否决今天的决定。

### 3.3 交互节奏（留存问题的真解）

不要试图靠"用户更频繁地来"解决问题，**要靠产品主动制造事件**。

| 使用频率 | 产品价值所在 |
|---|---|
| 高频（每天聊） | **沉淀**：不加负担地把碎念转成结构化状态 |
| 低频（一周一次） | **主动复盘 + 冲突质询**：他回来时，系统已备好"这周有 3 个变化需要确认" |

核心机制：

> **任何新事实进入时，系统必须检查它与已有档案是否兼容；不兼容就问，问不到就标记为"待确认"。**

这把维护准确性从**用户的责任**变成**系统的责任**。也就是说，**"状态档案带时间戳与出处"不是可选项，而是地基。**

## 4. 边界与风险（必须现在就定，不能事后补）

### 4.1 财务：三层降级策略

不做"必须接上账单"这种会被卡死的设计。

| 层级 | 数据来源 | 优先级 |
|---|---|---|
| L1 底线 | **人为输入**：基金/股市/存款/月收入/月均消费/买房目标 | 必做 |
| L2 增强 | **文件导入**：支付宝/微信账单 CSV、银行 Excel/PDF | 有则做 |
| L3 接入 | **外部 MCP**：有现成的就配，没有就不做 | 可选 |

**铁律：档案里每个数字必须带三个字段 —— 值、来源（手填/账单/MCP）、时间戳。**

手填的数字在输出里要**降权**，并显式标注"基于你在 X 月的手填数据，可能已过时"。

原因：一旦允许手填，用户填的数就成了唯一事实来源，而手填的数往往错、过时、或只是他愿意相信的版本。
典型场景：用户填"月结余 4000"，真实是 1500（忘了算房租年摊销和信用卡分期）。

不需要复杂实现，但这条决定了产品是"工具"还是"算命"。

### 4.2 谄媚防护（会直接毁掉产品）

一个迷茫焦虑的人来问"我该不该辞职去做 X"，模型倾向于说"你的想法很有价值，值得尝试"。这是 RLHF 的产物，不是模型坏。

**为什么深夜那次实验表现好**：总结任务没有讨好空间（"我当时说了什么"有客观答案）。
**但"该不该买/该不该辞"是决策任务，充满讨好空间**，同一模型会明显更不可靠。

必须写进设计的对策（不能靠 prompt 祈祷）：

| 对策 | 说明 |
|---|---|
| **强制证据锚定** | 每条判断必须引用用户原话/账单数字，引不出来就不许说 |
| **强制反方** | 必须给出"如果你错了，最可能错在哪" |
| **强制改判条件** | 必须给出"什么信号出现就该改主意" |
| **强制四分类** | 事实 / 推断 / 人工输入 / LLM 建议，全部可溯源 |
| **强制反证检索** | 给出正向结论时，必须同时检索用户历史中相反或削弱的证据 |
| **可回测预测** | 如"按此计划 3 个月后结余约增加 X"，事后可校验，才能校准 |

参考：[career-planning-skill](https://github.com/yutongcai0628/career-planning-skill) 的分寸写得好 ——
"信息足够时给出明确倾向；信息不足时设计低成本验证实验，**而不是列出很多方向让用户自己猜**"。

### 4.3 边界 A：财务建议 ≠ 投资建议

"帮我看清消费和现金流"是安全的；**"我该不该买这支基金"在中国是持牌业务，不能碰。**

产品输出定位为**决策支持与自我认知**，并附免责声明：

> 输出属于决策支持，不构成法律、劳动争议、签证、投资、税务、医疗或心理健康意见。

### 4.4 边界 B：核心场景天然包含心理状态

**灵感来源就是"深夜失眠、迷茫、焦虑地语音输入一小时"。用户会大量在这种状态下使用它。**

这意味着：

- AI 会给情感脆弱的用户**看起来很像专业建议**的东西，而模型会谄媚。
- 高强度使用本身可能是痛苦信号，不是健康信号。
- 需要**三层处理策略**（日常 / 持续痛苦 / 危机信号）：
  **日常的心事与"不想和真人说"是本职，绝不能劝他去找人**；
  持续痛苦时暂停规划、把专业帮助作为可选工具；
  危机信号时停止规划并说明理由。
  完整设计见 [敏感场景与心理边界](sensitive-scenarios.md)。

**硬约束：如果一个"思考组织器"的用户越用越离不开它，说明它失败了。**
因为它的目标是让用户获得**自己的**清晰度。
度量指标应该是"用户想清楚了"，**不是"使用时长"**。

### 4.5 本地化边界（已确定）

| 项 | 决定 |
|---|---|
| 数据 | **本地**：纯文本 / 结构化文件（Markdown + YAML/SQLite），可读、可 git、可迁移 |
| 推理 | **走 API**，不做本地模型（成本巨大，劝退用户） |
| 脱敏 | 二期议题 |
| 社区化的 | **接入层与能力层**（Skill / MCP / 领域模型），**绝非用户的私密数据** |

绝不做私有不透明数据库——那和云端没区别，只是服务器在家。

---

# 第二部分｜竞争

## 5. 竞品对比

对比轴不是功能覆盖，而是四个更本质的问题：
**它懂你？它行动？它记得你？它是否在时间上持续？**

| | 懂你（推理） | 行动（决策） | 记得你 | **时间维度**（主动/复盘/作废旧前提） |
|---|---|---|---|---|
| [LifeOS](https://github.com/Inovello/lifeos) | 只抽取不推理 | 变数据行 | 只有原始数据 | ❌ 明确不做 |
| 日记/反思类（[life-navigator](https://github.com/cielecki/life-navigator)） | 陪伴式对话 | ❌ | 有历史 | ➖ 靠用户自己回看 |
| [career-planning-skill](https://github.com/yutongcai0628/career-planning-skill) | ✅ 强 | ✅ 强（ABZ+90天） | 有档案 | ⚠️ 仅被召唤时更新 |
| 专精工具（[claude-finance-agents](https://github.com/jasonsieg22/claude-finance-agents)、[fsdmoney](https://github.com/geod/fsdmoney)） | 单域 | 单域 | ❌ | ❌ |
| 第二大脑（[Khoj](https://pypi.org/project/khoj/)、Obsidian 系） | 检索 | ❌ | 存了但不用 | ❌ |
| **记忆层**（[EverOS](https://github.com/EverMind-AI/EverOS)、[MemOS](https://github.com/MemTensor/MemOS)、[OpenViking](https://github.com/volcengine/OpenViking)、[honcho](https://github.com/plastic-labs/honcho)） | ➖ 提供上下文 | ❌ | ✅ **强（这是它们的本职）** | ❌ |
| 通用助手（[Friday](https://github.com/LakshyaBadjatya/Friday) 等） | 泛 | 弱 | 记忆浅 | ❌ |
| [DSH](https://github.com/deepseek-ai/deepseek-harness) | — | 通用 runtime | 会话级 | 底座，不含"你是谁的模型" |
| **MyLife** | ✅ | ✅ | ✅ **结构化+出处+时效** | ✅ **主动复盘 / 反证 / 作废旧前提** |

### 关于"记忆层"这一类的重要区分

DSH 插件目录里已有 **Memory** 分类，且站着几个强项目 —— 其中
[EverOS](https://github.com/EverMind-AI/EverOS) 的定位（local-first、Markdown-native、
user-owned、1.3 万星）与 MyLife 的表面描述**几乎撞在一起**。

**但两者不是一回事：**

| | 记忆层（EverOS / MemOS / honcho） | MyLife |
|---|---|---|
| 解决的问题 | **存得住、取得回** | **想得清、敢决策** |
| 对"矛盾"的处理 | 检索出相关片段 | **主动指出并质询** |
| 时间维度 | 版本化、可检索 | **失效、作废、主动回来问** |
| 输出 | 上下文 / 检索结果 | **带依据与反方的判断** |
| 定位 | 基础设施 | 上层应用 |

**结论：记忆层是 MyLife 可以站在上面的地基，而不是它的对手。**
甚至可以考虑**直接复用**其中一个（而不是自建存储），把精力全部投在认知层与时间层。

> **这也修正了一个容易犯的错误：不要去做"更好的记忆"。**
> 那件事已经有强项目做了，而且做得不差。MyLife 的护城河在**认知与时间维度**，不在存储。


### 空白定位

所有竞品都在**"你召唤它的时候"**工作。
**没有一个在"你没召唤它的时候"维护对你的理解。**

这个空白之所以存在，是因为它**技术上不难，但设计上很难**：
需要一份带出处的状态档案、一套证据时效规则、和一个主动触发机制。

### 关于 DSH 的定位（不是竞品，是底座）

> **"DeepSeek Harness: Everything is a Plugin."**

DSH 的宣言和 `Everything use LLM` 是同一个句式——但它是**通用**的。
它不可能知道"你"意味着什么。**MyLife 就是让 DSH 长出一个"你"的垂直 profile。**

---

# 第三部分｜实现

## 6. 技术路线：不是新 App，而是 DSH 的一个 profile

DSH 架构文档原文：

> **"不存在需要打补丁的特权内核：扩展 dsh 的方式是把插件挂载到其他插件旁边，而各项注册都是副作用，会在其插件卸载时撤销。"**
> **"产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 agent loop 本身。"**

所以形态是：

```sh
dsh --profile mylife        # 一个垂直 profile，不是新 App
```

### 6.1 DSH 既有能力与需求映射

| 需求 | DSH 现成能力 | 需自写量 |
|---|---|---|
| 网页操作本地文件 | `dsh web` + `dsh-fs-local` | **零** |
| 定时复盘 | `dsh-schedule`（会话内）+ 系统定时 + `dsh --profile headless` + IM 推送 | 小 |
| 领域规划（职业/旅游/购物） | **Skill**：`dsh-skill-filesystem` 扫目录里的 `SKILL.md`，改了不用重启 | 只写 Markdown |
| 账单/外部数据 | `dsh-mcp-client` | 有 MCP 就配置 |
| 推理与模型 | `ctx.llm` 适配器（API 即可） | 零 |
| 个人状态档案 | `dsh-storage-json` + 工作区 Markdown | 中 |
| 冲突质询/证据校验 | 钩子：`ctx.on('tools/pre-execute')` 可拦截并返回 allow/deny；`agent.followup()` / `agent.steer()` 可驱动回 agent | 中 |
| 查历史（"我上个月说过什么"） | `dsh-session-query-sqlite` —— 历史会话可 SQL 查询 | 小 |
| 自定义 UI（"我现在的状态"页） | `dsh.client` 注入浏览器插件 | 中 |

**结论：这个项目 80% 的工作量在产品设计与 Skill/档案的打磨上，不在写代码。**

## 7. 插件机制（已验证事实）

### 7.1 最小骨架（三文件）

```
dsh-mylife/
├── package.json          # 声明 bundle patch + client 注入
├── cordis.patch.yml      # 一行 insert 挂载插件
└── lib/
    ├── index.js          # 宿主侧（Node）
    └── client.js         # 浏览器侧（React）
```

### 7.2 package.json 关键字段

```jsonc
{
  "name": "dsh-mylife",
  "type": "module",
  "main": "lib/index.js",
  "engines": {                                  // ← 顶层！DshManifest 里没有 engines 键【已验证】
    "node": "^22.19.0 || >=24.0.0",
    "dsh": ">=0.1.5-rc.1"
  },
  "exports": {
    ".":        { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-renderer"]   // ← 仅装饰性，见 7.4
    }
  },
  "peerDependencies": { "react": "^18.2.0" }
}
```

**兼容性声明的真实情况【已验证】**：

- 权威类型 `DshManifest`（`dsh-package-manifest/lib/types/types.d.ts`）只有
  `bundle` / `profile` / `client` / `configTrees` / `sessionFormatMigration` / `moduleFallback`，
  **没有 `engines` 键**。
- 兼容性声明在**顶层 `engines.dsh`**，与 npm 的 `engines.node` 同一个对象。
- 实测官方包 `dsh-tools` / `dsh-schedule` / `dsh-client-ui-jobs`：**顶层和 `dsh.engines` 两者都没有**。
- 但本机第三方插件（`@climber47/dsh-step-clock`、`@xmanrui/dsh-im`）**写了 `dsh.engines.dsh`**，
  而 `dshmarket` 读的是**顶层** `engines.dsh`。
- **当前核心与市场都不强制检查，写错位置不报错也不生效。** 按上面模板写顶层即可。

### 7.3 cordis.patch.yml（一行挂载）

```yaml
# insert 行务必带 id —— 否则每次编辑配置都会被视为"删旧增新"重新挂载【已验证】
- insert:
    - id: mylife
      name: 'dsh-mylife'
```

**【已验证】`insert` 的两种形态**：

1. 顶层 `insert: [...]` —— 往插件树根推入新行（如上）。
2. `- id: <group行id>` + `insert: [...]` —— 往该 group 行的**子行数组**里推。
   group 行的 `config` **就是子行数组**（配套机制是 `isolate` + `group`，用于多实例/可复用）。

注意：**一条 patch 是按 id 定位并替换该条目的整个 config，不做深合并。**

### 7.4 client 侧注入的真相【已验证】

```ts
export interface DshClientManifest {
  platform: string
  /** Informational package-name dependencies, not Cordis service injection. */
  inject?: string[]
  immediately?: boolean
  external?: string[]
}
```

官方 `packages/client/AGENTS.md` 原文：

> "`inject` lists package-name dependency edges — they are **informational only**（预检显示、HMR diff）;
> **they do not sequence entry activation or apply order.** Activation order is Cordis fiber inject waiting on *services*, nothing else."

**结论：`dsh.client.inject` 纯装饰性，不决定加载顺序。**
往里面写包名**不会**让你的插件晚于对方加载。真正决定顺序的只有运行时 `inject`（服务等待）+ `external`（模块表请求）。

### 7.5 插件元数据导出（只有 6 个）【已验证】

```ts
export interface Base<T = any> {
  name?: string
  Config?: StandardSchemaV1<any, T>
  inject?: Inject          // 所需服务；全部可用才加载
  provide?: string | string[]
  intercept?: Dict<boolean>
}
```

**`export const reusable` 不存在，不要写。** 多实例用 `isolate` + `group`。

### 7.6 事件系统的坑【已验证】

> **`turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是持久化的会话事件类型，不是同名 Cordis 事件。需要观察它们时，监听 `session/event` 并检查 `event.type`。**

```js
// ❌ 错：这不是 Cordis 事件
ctx.on('tool/call', ...)

// ✅ 对
ctx.on('session/event', (session, event) => {
  if (event.type === 'tool/call') { /* ... */ }
})

// ✅ 想做策略拦截，用 tools/* waterfall
ctx.on('tools/pre-execute', async (exec, next) => {
  if (!(await isAllowed(exec))) return { kind: 'deny', reason: 'Denied by policy.' }
  return next()
})
```

工具执行流水线的可用扩展点：`tools/pre-execute`（策略门禁）、`tools/execute`（包裹生命周期）、
`tools/post-execute`（结果变换）、`tools/result`（只读观察）。
需要单调最终拒绝时用 `ctx.tools.guard()`。

### 7.7 工具命名规则【已验证】

- 同层重名**会失败**；作用域注册可遮蔽全局。
- **保留名 `run_code`**（源码里 `RUN_CODE_NAME = 'run_code'`），注册或遮蔽它会抛错。
- MCP 桥接工具命名：`mcp__<serverName>__<rawName>`，`serverName` 须匹配 `[A-Za-z0-9_-]{1,32}`。
- 第一方工具均为 snake_case 裸名（`bash`/`read`/`edit`/`write`/`glob`/`grep`/`todo_write`…）。

### 7.8 文件系统 seam【已验证】

**`ctx.fs` 是存在的**（`FileSystem` abstract seam，声明包 `packages/fs/fs`）。

| 组件 | 职责 |
|---|---|
| `ctx.fs`（`dsh-fs`） | 提供方原语：`resolve`/`stat`/`readText`/`writeText`/`editText` 等，原子写、可选 guard |
| `dsh-fs-local` | 本地磁盘后端实现 |
| `dsh-tool-fs` / `dsh-tool-fs-search` | **面向模型**的工具：`read`/`write`/`edit`、`grep`/`glob` |
| `dsh-fs-observation-policy` | 通过 `fs/*` waterfall 添加新鲜度规则（先读后写/编辑） |

**注意分工**：`ctx.fs` 是给插件用的服务；给模型用的文件能力是**工具**。
两者不是一回事——插件读写文件可以用 `ctx.fs`，也可以注册工具让模型读写。

加载了 `dsh-tool-fs` 的部署**也应加载** `dsh-fs-observation-policy`，使默认行为为"先读后写/编辑"。
（对 MyLife 尤其相关：这正是"改档案前先确认"的底层机制。）

### 7.9 服务与事件清单的来源【已验证】

- 服务共 **82 个 `ctx.<key>`**，官方穷举位置 = 各 `docs/subsystems/*.zh.md` 末尾的
  `<!-- BEGIN GENERATED cordis-surface -->` 区块（`### ctx.<key> — <Type>` + 签名 + 源码位置）。
- 官方明确要求：**"开发插件时应以这些生成区块和服务的 TypeScript 接口为准，不要维护另一份静态清单。"**
- 服务名通过声明合并进 `Context` 接口：
  `declare module '@deepseek-ai/cordis' { interface Context { greeter: GreeterService } }`
- 框架级混入（非 `ctx.*`）：`ctx.events`、`ctx.logger`、`ctx.reflect`、`ctx.registry`，
  以及 `ctx.on/once/emit/waterfall/plugin/inject/get/provide/effect/fiber` 等方法。

### 7.10 定时与复盘的硬限制【已验证】

`dsh-schedule` 原文：

> **"Reminders survive restarts, but delivery requires a live root agent: closed sessions keep reminders overdue until resumed."**

**"三个月后提醒我复盘"这种跨会话长周期提醒，用它不可靠**——三个月后你大概不会开着那个会话。

**务实方案**：

```
OS 级定时（macOS launchd / cron）
  → 触发 dsh --profile headless "执行季度复盘核对"
  → 投递结果（本机已有 @xmanrui/dsh-im + 飞书 MCP，可推到手机）
```

### 7.11 HMR 与调试【已验证】

- `patchReload`：`web`=live、`headless`/`sdk`/`sdk-minimal`/`acp`=startup、**自定义 profile 默认 live**。
- **`patchReload: live` 只重载配置层，不替换源码模块。** 改插件源码要生效需显式启用模块 HMR
  （`dsh-base` 插入的 `hmr` 配置项默认 `disabled: true`）。
- `ctx.effect(execute, label?)`：execute 立即运行，清理函数**逆序**执行。
  但**多个异步处置器会并发执行，不保证逐个完成**——有顺序依赖的清理必须塞进同一个 `ctx.effect()`。
- 查看组合后的配置树：`dsh --profile web --dump-config`（不启动）。打印出的任何条目都能被自己的 patch 替换。

## 8. 状态档案的设计（自写核心）

这是 MyLife 唯一真正的"自有数据格式"，也是全部价值的地基。

### 8.1 每条记录的最小结构

```yaml
- id: claim-2026-01-15-003
  topic: 职业去留            # 主题聚簇键
  claim: 我无法忍受当前的管理方式
  kind: 主观陈述             # 事实 | 主观陈述 | 数字 | 推断 | 未知
  source: 用户原话           # 用户原话 | 手填 | 账单导入 | MCP | LLM推断
  provenance: "2026-01-15 会话，原话：'我真的受不了这个管理了'"
  occurred_at: 2026-01-15
  context: 连续加班三周       # 当时的语境，用于后续还原
  confidence: high
  superseded_by: null        # 被哪条新证据取代 → 实现"旧前提作废"
  status: active             # active | stale | superseded | disputed
```

### 8.2 三条驱动规则

1. **新事实进入时校验兼容性** → 不兼容就问，问不到标 `disputed`。
2. **按 `topic` 聚簇 + 按 `occurred_at` 排序** → 这是"还原"而非"指控"的前提。
3. **时效判定** → 超过阈值（如 6 个月）的 `数字` 类记录自动标 `stale`，
   并在输出中显式提示"旧前提，是否仍成立"。

### 8.3 输出模板（固定形状，不可省略任何一段）

```markdown
## 核心判断
（一句话，必须能对回价值观/约束层）

## 证据
| 支持 | 削弱/反驳 | 出处 |
（引不出出处的判断不许写）

## 还原：你在这件事上的多种表述
（按主题聚簇 + 时间 + 语境，用提问而非指控收尾）

## 待作废的旧前提
（超过时效的约束，逐条问"还成立吗"）

## 主路径 / 相邻路径 / 安全底线

## 90 天行动
（每项含产物 + 验收信号）

## 如果你错了
（最可能错在哪）

## 什么信号出现就该改主意
（可观测的触发条件）

## 免责
决策支持，不构成投资/法律/医疗/心理健康意见
```

## 9. 实施路线

### 阶段 0｜零代码验证（一周内，先做这个）

**不要先写代码。先证明"反证引擎"有用。**

手工拿那篇 14000 字文档跑一遍 MyLife 该做的事：

1. 抽主线（已验证过，准）
2. 把同一主题的表述**按主题聚簇并标时间**
3. 找出互相拉扯处，用**还原**而非**指控**的语气写出来
4. 写出**哪些前提可能已过时**
5. 强制输出"如果你错了会错在哪" + "什么信号该改主意"
6. 手写 90 天计划 + 复盘日期

**判据**：
- 若第 3、4 步产出让你觉得"对，这就是我没想清楚的地方" → 核心机制验证成功，
  同时手上有了 README 最佳素材 + 可复用 prompt。
- 若产出是废话或冒犯 → 改设计，别写代码。

成本几小时，能挡掉几个月错误方向。

### 阶段 1｜最小 profile

```sh
dsh --profile mylife --from-default-profile web
```

产出：三文件插件骨架 + 一个 `mylife-state.yaml` + 一个 `SKILL.md`（主线抽取与输出模板）。

### 阶段 2｜接入领域与档案

- Skill 目录：职业透镜（可直接借 [career-planning-skill](https://github.com/yutongcai0628/career-planning-skill)
  的 ABZ + 90天 + 复盘条件范式）、财务透镜、旅游/购物（走外部 MCP）。
- 状态档案读写工具 + 兼容性校验钩子。
- 历史检索接 `dsh-session-query-sqlite`。

### 阶段 3｜时间层

- 复盘调度（launchd + headless + IM 推送）。
- 反证引擎与旧前提作废的自动化。
- 自定义 UI："我现在的状态"页（`dsh.client` 注入）。

### 阶段 4｜社区化

发布 `dsh-mylife` 到 npm，领域层鼓励社区贡献 Skill / MCP。

## 10. 参考：官方文档与样板

| 内容 | 位置 |
|---|---|
| 扩展插件形态（钩子/UI/协议驱动） | `docs/cookbook/extension-cookbook.zh.md` |
| 架构与 profile / 组合包 | `docs/architecture.zh.md` |
| 能力 seams 与服务映射 | `docs/capability-seams.zh.md` |
| Cordis API（context/service/events/registry/fiber） | `docs/cordis-api/*.zh.md` |
| 事件命名（`session/event` 的坑） | `docs/user/develop/framework/events.zh.md` |
| 文件系统 seam | `docs/subsystems/filesystem.zh.md` |
| 工具定义真源 | `docs/cookbook/adding-a-tool.zh.md` |
| 配置字段目录 | `docs/config-catalog.zh.md` |
| 本地 skill 提供方 | 包 `@deepseek-ai/dsh-skill-filesystem` README |
| 会话内提醒的边界 | 包 `@deepseek-ai/dsh-schedule` README |
| **真实第三方插件样板** | `~/.dsh/profiles/web/node_modules/@climber47/dsh-step-clock/` |
| 本机已装插件清单 | `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` |

官方文档 raw 前缀：`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/`
（注意：默认分支是 **`master`**，不是 `main`；直连需走本机 SOCKS5 代理。）

## 11. 一句话总结

产品从"生活助手"收敛成了 ——
**一个持续维护"你是谁"的本地档案，并在关键时刻主动回来质疑你的决策引擎。**

专精领域交给社区（Skill/MCP），推理走 API，数据留本地，runtime 用 DSH。
**只做那件没人做的事：让 AI 在时间维度上真正理解一个人，并且不谄媚。**
