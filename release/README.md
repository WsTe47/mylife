# 发布物料

这个目录存放两个分发渠道的**提交物料**与流程状态。

```
两个渠道（性质不同，都要做）
├── A. 官方 GitHub 话题  topics/dsh-plugin          ← 官方 README 推荐，零门槛
└── B. awesome-dsh-plugin → dsh-market（插件市场）  ← 社区策展，需提 PR
```

参考：[发布与社区贡献](../docs/design/release.md)、
[收录要求原文](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)

---

## 当前状态

| 步骤 | 状态 | 说明 |
|---|---|---|
| 仓库公开 | ✅ | https://github.com/WsTe47/mylife |
| **A. 官方话题 `dsh-plugin`** | ✅ **已完成** | 另加 `dsh` / `deepseek-harness` / `memory` / `local-first` / `decision-support` |
| `dsh.bundle.patch` 声明 | ✅ | `./cordis.patch.yml`（**最常见的被拒原因就是只声明 `dsh.client`**） |
| 仓库创建满 1 天 | ✅ | 创建于 2026-09-17T15:41:31Z |
| 打包内容校验 | ✅ | `npm pack --dry-run` → 18 文件 / 58.8 kB |
| **B-1. npm 包发布** | ⛔ **阻塞** | **npm 未登录**（`ENEEDAUTH`）。包名 `dsh-mylife` 未被占用 |
| **B-1 替代. 预构建 tarball** | ✅ **已完成** | 见下方「为什么必须走 tarball」 |
| **B-2. 向 awesome 提 PR** | ✅ **已提交** | [#5468](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5468) |
| **C. dsh-market 收录** | ⏳ 自动 | 市场读 awesome 的目录，**PR 合并后自动同步**，无需单独提交 |

> 说明：`dsh-market` 是社区插件市场（装在本机 Settings → Plugin Market），
> 但它的目录源就是 awesome-dsh-plugin。**所以不存在"两个独立提交"** ——
> 提交 B-2 即同时进入市场。官方 README 明确："This repo is the market app, not the catalog."

---

## 为什么必须走 tarball（不能只发源码）

收录要求原文：

> **不发 npm 也可以**：把预构建 tarball 附加到 GitHub Release，并用可选的 `tarball:` 字段指向它，
> 市场会优先展示它而不是源码构建命令。**如果你的仓库根本无法从源码安装，这一项是必需的。**

**本仓库正是"无法从源码安装"那一类**，实测确认：

```
$ 只复制 src/ + package.json（不复制 node_modules）→ 加载
  ✗ ERR_MODULE_NOT_FOUND
```

原因：`src/lib/yaml.js` 真的 `import yaml from 'js-yaml'`，
而源码安装不会带 `node_modules`。

### 处理方式

| 项 | 做法 |
|---|---|
| 打包自包含 | `bundleDependencies: ["js-yaml"]` → tarball 内含 `node_modules/js-yaml` |
| k资产名不带版本 | 命名为 `mylife.tgz`（**不是** `mylife-0.1.0.tgz`） |
| 为什么 | 官方明确警告：`latest/download/` 只在请求时解析 `latest`，**文件名照字面取** —— 带版本的名字提交当天有效，**下次发版就 404，而且没人会察觉** |
| 链接 | `https://github.com/WsTe47/mylife/releases/latest/download/mylife.tgz` |

### 已验证

- ✅ Release 资产存在（`mylife.tgz`，331,304 字节）
- ✅ 下载链接返回 HTTP 200
- ✅ 校验和与本地构建一致（`3bcb3ec3e7…`）
- ✅ **从 tarball 实际安装后**：插件加载成功、注册 12 个工具、YAML 读写正常

### 关于 peerDependencies

收录要求提醒：官方 `@deepseek-ai/*` 包须用 `peerDependencies` 声明，
且**不带显式预发布分支的范围会静默排除所有预发布构建**（ERESOLVE 陷阱）。

**本插件不声明也不 import 任何 `@deepseek-ai/*` 包** —— 这是刻意的，
既避开该陷阱，也让它能在任何目录布局下加载。

---

## B-2 的提交方式

**一个文件**，路径与内容如下（已备好，见 `awesome-dsh-plugin-entry.yml`）：

```
data/plugins/WsTe47__mylife.yml
```

```yaml
url: https://github.com/WsTe47/mylife
name: WsTe47/mylife
category: memory
description:
  en: '...'
  zh: '...'
```

要点（都来自 contributing.md 原文）：

- **只有 `description.en` 必填**；中文缺了维护者会补（"a missing translation is our work"）
- 描述含 `: ` 时**必须加引号**，否则 YAML 会当成嵌套键 —— 本次已加
- **不要手工改 README** —— 两个 README 由 `data/plugins/*.yml` 生成，合并后自动重建
- 分类不必纠结：官方明确"Nobody gets sent back over a category"

### 提交前自动检查项（CI）

| 检查 | 本仓库状态 |
|---|---|
| 声明 `dsh.bundle` manifest | ✅ |
| 仓库创建满 1 天 | ✅ 51.4 小时 |
| 有真实可用的代码（非占位/纯 README） | ✅ 18 个源文件 + 137 测试 |
| 活跃维护 | ✅ |

---

## 已提交的 PR

**https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5468**

- 只改一个文件：`data/plugins/WsTe47__mylife.yml`（评审项 #6：不碰无关条目）
- 描述含 `: ` 已加引号（YAML 陷阱）
- `en` / `zh` 均以句号结尾
- PR 正文逐条对着实现说明了描述里的每个断言

---

## 仍阻塞：npm 登录

发布 npm 包需要你的 npm 账号凭据。**我无法代你登录**（需要你的密码/2FA）。

两种做法：

**做法一（推荐）**：你自己在终端执行
```sh
npm login          # 或 npm adduser
cd /Users/climber47/dsh-mylife
npm publish --access public
```

**做法二**：给我一个 npm Automation Token（`npm_...`，仅 publish 权限），
我把它临时通过环境变量传给 `npm publish`，**不写进任何文件**。

发布成功后告诉我，我接着核对版本是否可安装，并引导 PR 提交。

---

## 发布后验证

```sh
npm view dsh-mylife version                    # 应显示 0.1.0
dsh plugin --profile web add dsh-mylife        # 应能装
```

以及一次干净安装的冒烟：在临时 profile 里装上、验证 12 个工具注册成功。
