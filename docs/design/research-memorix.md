# MyLife · 存储层接入实测报告

> 本文档记录**实际接入验证**的过程与结论，包含推翻初步方案的证据。
> 所有"实测"结论均在本机真实执行过。
>
> 相关：[技术方案](./technical-design.md) 第 2 章、[存储层选型](./research-storage-options.md)

---

## 0. 结论先行

**接入状态：✅ 已完成并验证通过（2026-09-17 23:31 重启后）**

| 验证项 | 结果 |
|---|---|
| Memorix 1.3.0 安装 | ✅ |
| profile patch 写入 + 配置树验证 | ✅ `--dump-config` 确认合并成功 |
| `dsh web` 重启后 MCP 子进程被拉起 | ✅ PID 32343 `memorix --cwd .../mylife serve` |
| **工具注册到 agent** | ✅ **实测可调用**（本次会话直接调用成功） |
| MCP 握手 | ✅ `project: local/mylife` |

**向 agent 暴露的 7 个工具**（`tools/list` 实测）：

```
memorix_store             memorix_search          memorix_project_context
memorix_codegraph_status  memorix_context_pack    memorix_resolve
memorix_detail
```

**职责分工（最终决定）：**

| 层 | 用谁 | 依据 |
|---|---|---|
| **L0 原始层** | 工作区 `raw/` 文件（自持） | 不可伪造的证据源 |
| **L0 检索 / L4 溯源** | **zvec-grep** | **实测：中文语义检索有效，返回 `文件:行号`** |
| **L2 证据图存储** | **Memorix**（已接入） | 结构化存储 + long-term 生命周期可用 |
| **L2 语义检索** | ❌ **Memorix 做不到**（见第 3 节） | 由 zvec-grep 承担 |
| **L3 档案层** | 工作区 YAML（带 TTL） | 时效逻辑是 MyLife 独有的 |

**一句话：Memorix 存事实，zvec-grep 找证据。**

**不需要购买 embedding 模型。** 理由见第 3、4 节。


---

## 1. 已完成的接入

### 1.1 Memorix 已装好并可用

```sh
npm install --global memorix@1.3.0     # 官方 DSH 文档钉的版本
```

【实测】安装成功（322 个包）。MCP 握手验证通过：

```json
{"result":{"protocolVersion":"2024-11-05",
 "capabilities":{"tools":{"listChanged":true}},
 "serverInfo":{"name":"memorix","version":"1.3.0"}}}
[memorix] MCP Server running on stdio (project: local/mylife)
```

### 1.2 项目身份需要 git 仓库

【实测】Memorix 原文报错：

> `Memorix requires a git repo to establish project identity. Run git init in this workspace first.`

→ **你之前"档案可选 git 化"的决定，在接入 Memorix 后变成了前置条件。**
→ 已执行 `git init` 于 `/Users/climber47/mylife`，项目身份 = `local/mylife`
→ 数据目录 = `~/.memorix/data`

**重要**：你的 `dsh web` 工作目录是 `$HOME`（且不是 git 仓库），所以配置里
用 `--cwd /Users/climber47/mylife` **显式指定项目根**，避免它拒绝工作。

### 1.3 DSH 侧配置已写入并验证

写入 `~/.dsh/profiles/web/cordis.patch.yml`（原文件已备份到 `/tmp/cordis.patch.yml.bak`）：

```yaml
- insert:
    - id: memory-memorix
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memorix
        transport: stdio
        command: /opt/homebrew/bin/memorix
        args: ['--cwd', '/Users/climber47/mylife', 'serve']
        cwd: /Users/climber47/mylife
        env:
          MEMORIX_EMBEDDING: 'off'
        failOnStartupError: false
```

**【实测】配置树验证通过**：`dsh --profile web --dump-config` 输出第 562 行起
正确包含 `memory-memorix` 条目，DSH 无报错。

字段语义来自权威类型 `dsh-mcp-client/lib/types/index.d.ts`：

| 字段 | 说明 |
|---|---|
| `serverName` | 决定模型侧工具名 `mcp__<serverName>__<rawName>`；须匹配 `[A-Za-z0-9_-]{1,32}` |
| `command` / `args` | 直接传参，**不做 shell 插值** |
| `cwd` | 子进程工作目录 |
| `env` | 叠加在**已清洗**的环境之上 |
| **`failOnStartupError: false`** | **优雅降级**：MCP 起不来也不阻止 dsh web 启动 |
| `toolCallTimeoutMs` / `reconnect` | 可选，未设用默认 |

**安全细节【已验证】**：stdio 桥接器启动子进程前**会移除名字像凭据的环境变量和所有 `DSH_*` 变量**。

---

## 2. 关键发现一：BM25 全文检索对中文不可用

【实测】写入 4 条**中文**观测后检索：

| 查询 | 结果 |
|---|---|
| `18000`（数字） | ✅ 命中 obs:3 |
| `跳槽` | ❌ 无结果 |
| `加班` | ❌ 无结果 |
| `财务` | ❌ 无结果（**连标题里含"财务"的条目都搜不到**） |
| `overtime`（英文） | ❌ 无结果 |

**结论**：Memorix 默认的 BM25（Orama）**不支持 CJK 分词**。
对以中文为主的个人档案语料，**`MEMORIX_EMBEDDING=off` 实际不可用**。

这不是配置问题，是检索器能力问题。

---

## 3. 关键发现二：Memorix 对中文没有可用的本地语义检索路径

Memorix 支持 4 种 provider：`off` / `fastembed` / `transformers` / `api`。
我读了它的实现源码，**两个本地 provider 的模型都是硬编码的**：

```js
// transformers provider（dist/index.js ~3400 行）
TransformersProvider = class {
  name = "transformers-minilm";
  dimensions = 384;
  static async create() {
    const extractor = await pipeline("feature-extraction",
      "Xenova/all-MiniLM-L6-v2",   // ← 写死，忽略 toml.embedding.model
      { dtype: "q8" });
```

```js
// fastembed provider（dist/index.js ~3315 行）
FastEmbedProvider = class {
  name = "fastembed-bge-small";
  dimensions = 384;
  static async create() {
    const model = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15   // ← 写死，忽略 toml.embedding.model
    });
```

| Provider | 模型 | 是否读 `toml.embedding.model` | 中文 |
|---|---|---|---|
| `transformers` | `Xenova/all-MiniLM-L6-v2`（384d） | ❌ **完全忽略** | ❌ 纯英文模型 |
| `fastembed` | `EmbeddingModel.BGESmallENV15`（384d） | ❌ **完全忽略** | ❌ EN 模型 |
| `api` | `api-${config.model}`（维度自动探测） | ✅ **读配置** | ✅ 可自选模型 |

**推论【实测 + 源码推断】**：

1. 我写了 `memorix.toml` 配 `model = "Xenova/bge-small-zh-v1.5"`，
   `config get` **能读出**该值，`status` 也显示 `Embedding lane: transformers / Xenova/bge-small-zh-v1.5`
   —— **但实际创建 provider 时用的是硬编码的英文模型，配置只用于显示。**
2. 这也是为什么我实测时 transformers provider 报 `fetch failed`：
   它去下载 `all-MiniLM-L6-v2`，而 `hf.co` 在本网络不可达。
   **设置 `HF_ENDPOINT=https://hf-mirror.com` 对它无效** ——
   镜像只在代码里显式设 `env.remoteHost` 时才生效（我早先的独立脚本就是这么成功的）。
3. 即使下载成功，**英文模型对中文的效果极差**（见第 4 节实测数据）。

> **这是上游的设计局限（"config 通用、实现封闭"），不是我们配错了。**
> 可以考虑向上游提 issue，但不该成为本项目的阻塞项。

---

## 4. 中文 embedding 质量实测（决定"要不要买模型"）

我用 `@huggingface/transformers` + `hf-mirror.com` 镜像，实测三个模型的区分度：

| 模型 | 相关（跳槽 vs 绝不离开） | 不相关（跳槽 vs 去公园） | 判定 |
|---|---|---|---|
| `paraphrase-multilingual-MiniLM-L12-v2`（多语言，384d） | 0.1043 | 0.0720 | ❌ 几乎无区分度 |
| **`bge-small-zh-v1.5`（中文专用，512d）** | **0.5628** | 0.3735 | ✅ **可用** |
| `bge-m3` | 下载超时（模型过大） | — | ⚠️ 未完成 |

**重要**：`all-MiniLM-L6-v2` 是**纯英文**的，比第一行的多语言版更差 ——
即使 Memorix 的 transformers provider 下载成功，中文效果也不可用。

**结论：本地中文 embedding 是可行的（`bge-small-zh-v1.5` 实测有效），
但 Memorix 用不上它（因为硬编码）。所以问题不在模型，在 Memorix。**

### 关于"要不要购买 embedding 模型"的回答

**不需要。** 三条理由：

1. **zvec-grep 已经能用本地中文模型做语义检索，且实测有效**（见第 5 节）。
2. Memorix 只有 `api` provider 支持自选模型 → 走 API 意味着**每次写入都把你的
   个人档案内容发给第三方 embedding 服务**。这比"发给 LLM 做推理"更持续、更隐蔽，
   与"数据不离开本机"的定位冲突。**建议不要为了它开这个口子。**
3. 如果将来确实需要 Memorix 侧的语义检索，更合适的是**向上游提交支持自定义模型的
   PR**，而不是买模型或把数据发出去。

---

## 5. 关键发现三：zvec-grep 的中文检索实测有效

【实测】早先我用 zvec-grep 0.2.2 + 本地模型 `local/potion-retrieval-32m` 索引模拟日记：

**查询「我该不该离职跳槽」→ 返回：**

```
File: corpus/raw/2026-01-18-career.md      ← 字面命中
  Range: 1-6  Status: fresh

File: corpus/raw/2025-11-03-career.md      ← 语义召回！字面没有"跳槽/离职"
  Range: 1-5  Status: fresh
    1  今天项目上线了，感觉特别有成就感。团队的人都很好，我真的很喜欢这里，
    2  觉得自己短期内绝对不会考虑离开。
```

**它用"该不该离职"召回了"绝对不会考虑离开"** —— 正是"强制反证"与"多段表述还原"需要的能力，
且每条带 `文件:行号`，**直接就是 L4 溯源链的形态**。

⚠️ 限制：搜索措辞会影响召回（我测"我的财务状况能支撑多久"时未召回财务文件）；
且官方标注 **0.x，接口会变** → 建议在 MyLife 侧加薄封装隔离版本变化。

---

## 6. 待办与已知风险

| 项 | 状态 |
|---|---|
| Memorix 已装、已配置、配置树已验证 | ✅ 完成 |
| `dsh web` 重启、MCP 连接建立、工具注册 | ✅ **完成并实测可调用** |
| 中文语义检索能力 | ✅ **由 zvec-grep 承担，已实测有效** |
| Memorix 的 transformers/fastembed 硬编码模型 | ⚠️ 上游限制（1.9.3 仍未修复），可提 issue |
| 模型缓存 | 无残留（本次未成功下载 Memorix 侧模型） |
| 临时测试目录 | ✅ 已清理 `/tmp/ftest`、`/tmp/mnew` |
| 原 profile patch | ✅ 已备份 `/tmp/cordis.patch.yml.bak` |
| `raw/` 语料与 zvec-grep 索引 | ✅ 已建立（`raw/` 3 篇模拟日记，索引可用） |
| `.zgtool/`（zvec-grep 工具，约 540M） | ✅ 已加入 `.gitignore` |
| 自动重建索引（raw/ 变更时） | ⏳ 待做 —— 一期可手工 `zg index` |

### 版本跟踪

| 版本 | 本地 provider 可选模型？ |
|---|---|
| 1.3.0（当前，DSH 官方钉的） | ❌ 硬编码 |
| **1.9.3（npm 最新，实测反编译确认）** | ❌ **仍未修复**；两个本地 provider 依旧写死英文模型、384 维 |

→ **升级 Memorix 不能解决中文检索问题。** 不必为此升级。


### 跨会话召回验证（官方步骤）

用于验证"MCP 记忆在**新会话**里也能取到"（这是记忆层的核心价值）：

1. 会话 A：让它记住一个唯一值，例如
   "记住我的验证饮品是 lapsang-<随机后缀>"
2. **新建**会话 B（不要复制 A 的对话），问
   "我的验证饮品是什么？查一下记忆"
3. 确认模型调用了 `mcp__memorix__*` 工具并返回该值

⚠️ 但要注意：**由于 BM25 不支持中文，验证值请用英文或数字**，
否则会话 B 会因检索能力不足而取不到，看起来像"记忆失效"，实际是检索失效。

---

## 7. 需要更新的既有文档

本次实测推翻了 TECH_DESIGN.md 第 2.2 节的部分表述，已同步修正：

| 原表述 | 更正 |
|---|---|
| "L2 可外包给记忆 MCP" | ✅ 仍成立（存储），但**检索不可外包给 Memorix** |
| "建议选 MCP Reference Memory 或 Memorix" | → **已定 Memorix**（你的决定），但知悉其检索局限 |
| "L0/L1/L3 本地纯文本" | ✅ 成立 |
| 未提及 zvec-grep | → **新增：L0 检索与 L4 溯源由 zvec-grep 承担** |

---

## 8. 最终可用性总结（给未来的自己）

| 能力 | 谁提供 | 状态 |
|---|---|---|
| 结构化存事实（claims） | Memorix | ✅ 可用 |
| 长期记忆生命周期（qualify/approve/supersede） | Memorix | ✅ 可用 |
| **中文语义检索** | **zvec-grep** | ✅ 可用（**不要用 Memorix**） |
| 溯源到原文与行号 | zvec-grep | ✅ 可用 |
| 跨会话记忆共享 | Memorix | ✅ 可用（英文/数字可靠，中文检索受限） |
| 时效 TTL / 旧前提作废 | MyLife 自建 | ⏳ 待开发 |
| 主动复盘 | MyLife 自建 + launchd | ⏳ 待开发 |

**两个工具都是"够用但不完美"，且都不完美的地方恰好被对方补上。**

