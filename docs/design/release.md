# MyLife 发布与社区贡献

> 配套：[产品定义](./vision.md)、[技术方案](./technical-design.md)、[路线图](./roadmap.md)
>
> 本文档基于对官方 README、awesome-dsh-plugin 贡献指南、dsh-market README 的直接核实。
> 核实日期：2026-09（对应 dsh 0.1.5-rc.1 / dshmarket 已装于本机）。

---

## 1. 结论：两个渠道，性质不同，都要做

你对 DSH 插件生态的观察是准确的 —— 官方 README 确实给了引导。但要区分清楚**两个并存的渠道**：

| | **A. 官方 GitHub 话题** | **B. awesome-dsh-plugin → dsh-market** |
|---|---|---|
| 谁推荐 | **官方 README 明确推荐** | 社区自发，官方未提及 |
| 地址 | `github.com/topics/dsh-plugin` | `awesome-dsh-plugin/awesome-dsh-plugin` |
| 性质 | GitHub 标签，**无门槛、无审核** | **策展目录**，有维护者审核 |
| 怎么进 | 给自己的仓库加 topic 标签 | 提 PR 加**一个** YAML 文件 |
| 用户发现路径 | GitHub 站内搜 topic | DSH 内 Settings → Plugin Market，**一键安装** |
| 能一键安装 | ❌ | ✅ |
| 维护者 | GitHub 平台 | 社区组织 |

**【已验证】** 官方 README 的 "Community and support" 章节原文（共三条）：

```
- Submit feedback or bug reports through GitHub Discussions.
- Add the [dsh-plugin](https://github.com/topics/dsh-plugin) topic to your
  plugin repository for discoverability.
- Join the DeepSeek Harness Discord community.
```

→ **官方只推荐了话题标签，没有推荐 awesome-dsh-plugin。** 后者是社区生态，两者互不隶属。

**重要判断：官方刻意把生态分发让给社区。** `deepseek-ai` 官方组织内**没有**任何
registry / market 仓库。这与 "Everything is a Plugin" 的哲学一致 —— 连市场本身都是社区插件。

**对 MyLife 的意义：这个生态门槛低、开放，个人项目完全可以挤进去。**
参考体量：harness 本体 ~22.7 万星，awesome 列表 ~1.6 万星，dsh-market ~4 千星
→ **目录层远未饱和。**

---

## 2. 渠道 B 的收录要求（已核实）

### 2.1 投稿就是一个文件

**【已验证】** `contributing.md` 原文："**The READMEs are generated — don't edit them by hand.**
The list lives in `data/plugins/`, one YAML file per plugin."

PR 添加**一个**文件，命名为 `<owner>__<repo>.yml`：

```yaml
# data/plugins/climber47__mylife.yml
url: https://github.com/climber47/mylife     # 必须与仓库完全一致
name: climber47/mylife                        # 列表中显示的链接文字
category: memory
description:
  en: A local-first personal state record and decision engine that reconstructs the thread through your confusion, argues against its own conclusions, and retires premises you have outgrown.
  zh: 本地优先的个人状态档案与决策引擎：从你的混乱中重构主线，强制反驳自己的结论，并作废你已经走出的旧前提。
```

- **只有 `description.en` 必填。**
- 中文可留空（维护者会补，官方原文："a missing translation is our work, not a reason to bounce your plugin"）。
- 合并后 README 会**自动重新生成**，不要手工改 README。

### 2.2 分类选择

**【已验证】** 可用的 `category` 取值：

```
agi ui usage theme model identity session memory tools wsl browser
vision voice docs skill workflow git notify dev security remote market fun
```

**建议 MyLife 选 `memory`。**
理由：MyLife 的一等公民是"个人信息的存储与维护"，`memory` 最贴切；
"决策/规划"没有精确对应分类，硬凑不如放准第一层。

备选：`tools`（强调它是工具集）或 `skill`（如果以 Skill 为主要交付形态时）。

**官方说明不必纠结分类**（原文）："Nobody gets sent back over a category — if a better
one fits, a maintainer just changes it."（不会有人因为分类被打回，维护者会直接改。）

### 2.3 两个会踩的坑

**坑 1：description 含 `: `（冒号+空格）必须加引号**

```yaml
description:
  en: 'Vision toolkit: OCR, grounding and pixel diff.'   # ✅ 加引号
  en: Vision toolkit: OCR, grounding and pixel diff.     # ❌ YAML 解析失败
```
（中文全角冒号 `：` 无此问题，但加引号也无妨。）

**坑 2：最常见的被拒原因是只声明了 `dsh.client`**

**【已验证】** 官方原文：

> ⚠️ "Most rejected submissions declare only `dsh.client` — that alone is **not** installable."

必须在 `package.json` 里声明 `dsh.bundle.patch`：

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ← 必须（这才让它可安装）
    "client": { "platform": "web" }                 // 仅带前端 UI 时才需要
  }
}
```

并在仓库根放 `cordis.patch.yml`：

```yaml
- insert:
    - id: mylife
      name: dsh-mylife
```

### 2.4 其余门槛（宽松）

- 仓库需**创建满 1 天**（CI 自动检查，防"PR 前几分钟才建仓"）
- 有真实可用的代码（占位 / 纯 README / 抢注不收）
- 项目处于活跃维护状态（定期扫描，长期停更会被移除）
- **无提交数门槛**（官方明确说明历史长短反映开发习惯而非质量）

**审核会看什么【已验证】**：代码是否与条目声明一致（包括描述里的数字）、分类是否合理、
是否真实可用、是否与已有条目重复（**"规则不是先来后到，规则是谁更好"**）、
源码是否有可疑之处。

---

## 3. 渠道 A：官方话题标签

**最低成本、最高确定性的一步。**

在 GitHub 仓库页面 → About 齿轮 → Topics → 添加 `dsh-plugin`。

**成本：30 秒。收益：进入官方 README 指定的发现路径。**

这一条不依赖任何审核，**建议仓库一公开就立刻做**，不用等发布。

---

## 4. 其他值得的贡献点

| 贡献点 | 做什么 | 价值 |
|---|---|---|
| **npm 发布** | 发布 `dsh-mylife`（顶层 `engines.dsh` 必写） | 安装源，渠道 B 的前提 |
| **官方 Discussions** | 在 harness 仓库分享实践、回答问题 | 官方指定的反馈渠道，建立存在感 |
| **Discord** | 官方社区 | 早期用户与反馈 |
| **领域 Skill 的贡献** | 让社区贡献字段定义与领域透镜 | 符合"领域交给社区"的分工 |
| **翻译** | README 中英双语 | awesome 列表本身是中英双语的，双语是社区惯例 |

**关于 `engines.dsh`【已验证】**：写在**顶层** `engines`，不是 `dsh.engines`。
`dshmarket` 正是靠它判断兼容性（`lib/discovery-compatibility.js` 读 `manifest.engines` → `engines?.dsh`）。
写错位置不报错也不生效。

---

## 5. 发布前的就绪清单

### 代码侧

- [ ] `package.json` 声明 `dsh.bundle.patch`（**最容易漏，最容易被打回**）
- [ ] `cordis.patch.yml` 存在，且 `insert` 行**带 `id`**
- [ ] 顶层 `engines.dsh` 写明兼容的 DSH 版本
- [ ] 仓库根有 `package.json`、`README.md`、`LICENSE`
- [ ] 仓库创建满 1 天

### 文档侧

- [ ] README 顶部有**免责声明**
- [ ] README 有**隐私说明**：数据在本地；启用云端模型时哪些内容会离开本机
- [ ] **卸载与迁移说明**：档案文件在哪、怎么带走（本地优先的承诺必须落到这一步）
- [ ] **危机信号处理说明**（见 ROADMAP 第 6.2 节）
- [ ] 一份**可离线打开的示例报告**（最有说服力的素材）
- [ ] README 中英双语

### 伦理侧（不可省）

- [ ] 明确写 **"不是心理支持工具"**，不把"陪伴感"当卖点
- [ ] 不做推送式挽留、不做连续使用激励
- [ ] 输出始终给"判断 + 依据 + 反方 + 改判条件"，不给"你该这样做"

---

## 6. 安全边界：必须自己讲清楚

**【已验证】** awesome-dsh-plugin README 顶部的 WARNING 原文：

> "Installing a plugin runs third-party code on your machine with your own permissions —
> it can read your files, use your credentials, and reach the network.
> **Tool approvals don't sandbox plugin code.** Being on this list is not a security review."

**两个推论：**

1. **对 MyLife 是正面论据**：一个要接触你全部私密档案的插件，如果
   **数据全在本地、不碰凭据、不上传**，这正是它最该被信任的理由 —— 我们应主动把这点写进 README。
2. **也要诚实地说明反面**：用户装任何插件都等于给了它你的权限。所以 MyLife 应该
   **明确列出自己索取的能力**（读哪些目录、是否需要网络），并说明为什么需要。

**建议在 README 里加一节 "Permissions"，逐条列出**：读取工作区档案目录、写入档案目录、
调用你配置的 LLM API（并说明发送内容）、以及**不做**的事（不读凭据、不访问档案目录以外的文件）。

---

## 7. 行动顺序

```
1. 仓库公开 → 立刻加 dsh-plugin topic（渠道 A，零成本）
2. 按就绪清单补齐代码与文档
3. 发布 npm 包 dsh-mylife
4. 向 awesome-dsh-plugin 提 PR（一个 YAML 文件）（渠道 B）
5. 合并后：dsh-market 通常一天内同步
6. 发一条 GitHub Discussions / Discord，介绍设计动机（讲"深夜 14000 字"那个故事）
```

**第 6 步不要省。** 这个项目最有力的传播材料不是功能列表，而是
**"一个人真的在那个状态下被 AI 帮到了"** 这个真实经过 —— 它同时解释了产品为何存在、
为何强调溯源与反谄媚、以及为何把伦理约束写进设计。
