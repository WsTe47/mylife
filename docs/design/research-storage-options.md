# 三个候选项目的调研与分工

> 你问的三个项目：`zvec-grep`、`Memorix`、`MCP Reference Memory`。
> 结论：**它们不是同类竞品，而是三种不同物种。** 而且其中两个恰好补上 MyLife 缺的两块。
>
> 标注：**【实测】**= 我在本机实际装好跑通验证过；**【原文】**= 官方文档/README 逐字；**【推断】**= 合理推断。

---

## 0. 一句话区分

| 项目 | 一句话 | 物种 |
|---|---|---|
| [zvec-grep](https://github.com/zvec-ai/zvec-grep) | 在**你的已有文件**里做混合检索，返回原文 + 精确出处 | **检索层**（读你的文件） |
| [Memorix](https://www.npmjs.com/package/memorix) | 维护一张**关于你的事实图**，跨会话共享 | **记忆层**（存提炼出的事实） |
| [MCP Reference Memory](https://www.npmjs.com/package/@modelcontextprotocol/server-memory) | 官方参考实现的知识图谱记忆服务器 | **记忆层**（最小、零依赖） |

**关键区别一句话：**

> **zvec-grep 回答"你在哪里说过这件事"（返回原文）。**
> **Memorix / Reference Memory 回答"关于这件事你的事实是什么"（返回结构化条目）。**

前者是**证据的检索**，后者是**事实的存储**。MyLife 两个都需要。

---

## 1. zvec-grep（zg）—— 这个最有意思

**它不是一个记忆系统，是一个本地优先的检索层。** 这是你不理解它用途的根本原因 ——
它压根不存"记忆"，它只搜你**已经有的文件**。

### 1.1 它是什么【原文】

> "**zg** (zvec-grep), powered by [zvec](https://github.com/alibaba/zvec), unifies
> **ripgrep, BM25, and vector search** behind one local-first interface."

| 项 | 值 |
|---|---|
| npm 包 | `@zvec/zvec-grep`（latest **0.2.2**） |
| 语言 / 许可证 | TypeScript / **Apache-2.0** |
| 要求 | Node ≥ 22 |
| 底层 | 阿里 [zvec](https://github.com/alibaba/zvec) 向量引擎 |
| 索引位置 | 项目根下的 `.zvec-grep/` |
| 检索方式 | 混合：**ripgrep（精确/正则）+ BM25（词法）+ 向量（语义）**，RRF 融合 |
| Agent 接入 | **Streamable HTTP MCP**，端点 `http://127.0.0.1:7999/mcp` |
| 暴露工具 | `zvec_grep_search`（默认只暴露搜索，故意收窄） |
| 本地模型 | 支持本地 embedding（如 `local/potion-retrieval-32m`） |
| 隐私 | "files, indexes, and local models stay on your machine" |

**它支持的输入格式**远超代码：文档、书籍、研究材料、会议纪要、知识库导出、
说明书、配置、结构化数据 —— 官方明确说"同一套规则适用于源码和非代码材料"。

### 1.2 【实测】我实际跑通了，结果很关键

我在本机装了 0.2.2，造了一份带**互相矛盾表述**的模拟日记（3 个文件），建索引并查询：

```
$ zg index --embedding local/potion-retrieval-32m
files  4 scanned, 4 added, 0 failed
duration 24s
```

**查询：「我该不该离职跳槽」→ 返回 3 个文件，包括：**

```
File: corpus/raw/2026-01-18-career.md      ← 字面命中（"开始认真考虑跳槽"）
  Range: 1-6  Status: fresh
    1  连续加班三周了，每天到十一点。我真的受不了这个管理方式，
    2  开始认真考虑跳槽。但是一想到大厂的学历门槛...

File: corpus/raw/2025-11-03-career.md      ← 语义召回！字面完全没有"跳槽/离职"
  Range: 1-5  Status: fresh
    1  今天项目上线了，感觉特别有成就感。团队的人都很好，我真的很喜欢这里，
    2  觉得自己短期内绝对不会考虑离开。
```

**这一条实测结果直接证明了它对我们核心功能的价值：**

> 用"我该不该离职跳槽"查询，它把**"绝对不会考虑离开"**也召回了 ——
> 而这正是"强制反证"和"多段表述还原"需要的**反向证据检索**能力。

而且每个结果都带 `文件:起止行` 的**精确出处**（`Range: 1-6`），
这直接就是我们的 L4 溯源链所需要的形态。

**限制（也要如实记下）**：
- 我测的"我的财务状况能支撑多久"这次**没有**召回财务文件，召回质量依赖查询措辞与语料
- 官方文档明确标注 **"zvec-grep is a work in progress. Commands and configuration may change before the first stable release."** → **0.x，接口会变**
- 索引是**构建时**产物，语料更新需要重建/刷新

### 1.3 对 MyLife 的意义

**它可能是整个方案里最被低估的一块。** 因为它一次解决三个问题：

| 我们的需求 | zvec-grep 提供 |
|---|---|
| 从海量 raw/ 里找到相关证据 | ✅ 混合检索 |
| 找到**反向/矛盾**证据 | ✅ **实测：字面无关的相反表述也能召回** |
| 溯源到原文与行号 | ✅ 内置 `文件:行范围` |
| 数据留在本地 | ✅ 本地索引 + 本地模型 |
| 不让 agent 读一堆无关文件 | ✅ 官方卖点："less context, fewer tool calls" |

**即：L0 原始层的检索与溯源，可以用它，不必自建。**

---

## 2. Memorix —— 记忆层，功能较全

| 项 | 值 |
|---|---|
| npm 包 | `memorix`（latest **1.9.3**；**DSH 官方参考配置钉在 1.3.0**） |
| 许可证 | Apache-2.0 |
| 定位【原文】 | "**Local-first shared memory layer** for AI coding agents across MCP clients, Git history, reasoning context, and project sessions." |

### 关键特性【原文 / DSH 官方文档】

- **无需 LLM 或 embedding**，可在本地启发式模式下运行 → 零额外成本
- 配置在它自己的 `~/.memorix/config.toml`，数据默认在 `~/.memorix/data`
  （可用 `MEMORIX_DATA_DIR` 覆盖）
- DSH 官方参考配置**沿用工作目录的 Git 项目标识**

### 注意

- **版本差异**：DSH 官方文档钉的是 `1.3.0`，npm 上已是 `1.9.3`。
  用官方 overlay 时会装 1.3.0，想用新版需自行调整。
- 它的数据在 `~/.memorix/`，**不在你的工作区** → 这点与"数据可迁移"的承诺要权衡。

---

## 3. MCP Reference Memory —— 记忆层，最小实现

| 项 | 值 |
|---|---|
| npm 包 | `@modelcontextprotocol/server-memory`（latest **2026.8.31**；DSH 官方钉 `2026.7.4`） |
| 定位【原文】 | "MCP server for enabling memory for Claude through a **knowledge graph**" |
| 模型 | **实体 / 关系 / 观察**（entity / relation / observation） |
| 存储 | 本地 **JSONL**，默认 `$HOME/.dsh-mcp-reference-memory.jsonl`（可用 `MEMORY_FILE_PATH` 覆盖） |
| 依赖 | **零**，不需要模型或 embedding |

### DSH 官方对这台的明确说明【原文】

> "搜索只对实体名称、类型和观察进行**不区分大小写的子字符串匹配，不是语义检索**。
> 该服务器**不提供 embedding、自动摘要、冲突消解或遗忘策略**。"

**优点**：极简、可读（JSONL）、零依赖 —— 适合当作"我们自己的 schema"的骨架。
**缺点**：没有语义检索 → **这正是 zvec-grep 要补的位置**。

---

## 4. 结论：它们如何拼进 MyLife

三者不是竞争关系，而是**两个层次**：

```
┌─────────────────────────────────────────────────────────┐
│ MyLife（我们做）：引导 · 决策 · 反证 · 时效 · 主动复盘      │
└───────────────┬─────────────────────┬───────────────────┘
                │                     │
     需要"事实"  │                     │  需要"证据原文"
                ▼                     ▼
   ┌────────────────────┐   ┌──────────────────────────┐
   │ 记忆层（选一个）     │   │ 检索层：zvec-grep         │
   │ Memorix            │   │  索引 raw/ 全部原始输入    │
   │   或               │   │  返回 原文 + 文件:行号      │
   │ MCP Reference      │   └──────────────────────────┘
   │ Memory             │              │
   └────────────────────┘              │
        L2 证据图                       │ L4 溯源链的实现
        （结构化事实）                    （回原始文本）
```

### 与四层模型的对应

| 层 | 交给谁 | 理由 |
|---|---|---|
| **L0 原始层** | 工作区文件（**自持**）+ **zvec-grep 做索引** | 原文必须在你手里；检索外包 |
| L1 摘要层 | 工作区文件 | 可重新生成 |
| **L2 证据图** | **Memorix 或 Reference Memory** | 结构化事实 + 跨会话共享，正是记忆层的本职 |
| **L3 档案层** | 工作区 YAML | TTL 与失效逻辑是我们独有的 |
| **L4 溯源链** | **zvec-grep 提供 `文件:行号`** + 自建 claim→文件 指针 | 实测已具备该形态 |

### 我的建议（分工，不是二选一）

1. **L0/L4 用 zvec-grep** —— 实测证明它能召回语义相关的相反表述并给出精确出处，
   这正好是"反证引擎"和"溯源链"的基础设施。**但接受它 0.x 会变接口的风险**，
   所以在 MyLife 侧加一层薄封装，隔离版本变化。
2. **L2 用记忆层**，且**先选 `MCP Reference Memory`** —— 零依赖、JSONL 可读、
   模型（实体/关系/观察）与我们的"证据图"最贴合。它的短板（无语义检索）
   **正好由 zvec-grep 补上**，两者互补而非重复。
3. **Memorix 留作备选** —— 功能更全（含 Git 历史与会话上下文），
   但数据落在 `~/.memorix/`、且官方钉的版本落后 npm 六个小版本。
   如果后续需要"跨项目共享记忆"，再引入。
4. **不要自建向量库** —— 这是最初想避免的工程量，现在有两个现成选择。

### 一个必须接受的取舍

用这两个外部件之后，**"数据全在你的工作区目录里"这句话就不完全成立了**：
- `~/.memorix/` 或 `~/.dsh-mcp-reference-memory.jsonl` 是它的数据位置
- `.zvec-grep/` 索引在工作区内（可重建）

**因此 README 里必须如实写清楚**：哪些数据在工作区（L0/L1/L3）、
哪些在外部服务器的数据目录（L2）、索引是否可重建。
**这比含糊地说"数据都在本地"更可信**，也符合我们对"权限透明"的要求。

---

## 5. 下一步建议

1. **先按官方指南把 `MCP Reference Memory` 接上**（零依赖，最快验证路径）
   ```sh
   npm install --global @modelcontextprotocol/server-memory@2026.7.4
   dsh web --patch apps/cli/config/examples/mcp-memory/mcp-reference-memory.cordis.yml
   ```
   并按官方验证法测一遍：会话 A 写入 → **新建**会话 B 召回（不必重启 Host）。
2. **再评估 zvec-grep 是否作为可选依赖**（它是 0.x，接口会变，
   建议做成"装了就用、没装降级到普通 grep"）。
3. 两条都验证过，再决定 MyLife 的 L2 到底落在哪。

> **注意**：官方对这三份配置注明"仅作为互操作参考；
> **收录不代表 DeepSeek 的认可、推荐、合作关系或持续支持承诺**"。
> 我们引用时沿用同样的措辞。

---

## 6. 本机副作用记录（已处理）

为验证 zvec-grep 我做了以下操作，**如实记录**：

| 操作 | 状态 |
|---|---|
| 全局 `npm install -g @zvec/zvec-grep` | ❌ 被沙箱拒绝（无 `/opt/homebrew` 写权限）—— **未安装** |
| 工作区内 `mylife/.probe/` 临时安装并实测 | ✅ 已完成，**已删除**（542M） |
| 下载本地 embedding 模型 `potion-retrieval-32m` | ⚠️ **保留在 `~/.zvec-grep/models/`（约 130M）** |

最后一项在工作区外，我无法删除（越权）。**这是你自己机器上的缓存，无害**。
若不打算用 zvec-grep，可自行删除：
```sh
rm -rf ~/.zvec-grep
```
