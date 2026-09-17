/**
 * MyLife — 本地优先的个人状态档案与决策引擎（DSH 插件）
 *
 * Everything use LLM 的那一半由 harness 提供；本插件补的是另一半：
 * 一个持续维护"你是谁"的本地档案，以及一套**不谄媚**的决策流程。
 *
 * 三层职责：
 *   采集层  永不要求用户先整理 —— mylife_record 把原文一字不改地收下
 *   认知层  主线抽取 + 带出处与时效的状态档案 + 反证库
 *   时间层  逐字段 TTL、旧前提作废
 *
 * 设计原则（不可退让）：
 *   1. **能用结构解决的，不要用提示词解决。**
 *      所以"每条判断必须锚定证据"是通过 mylife_trace 让"引不出出处"
 *      变成可检测的事实，而不是靠 prompt 祈祷模型诚实。
 *   2. **反证输出是提问，不是指控。**
 *      人的多面性不是错误。详见 lib/evidence.js 的模块注释。
 *   3. **反谄媚**：强制证据锚定 / 强制反方 / 强制改判条件 / 事实与推断分离。
 *
 * @module dsh-mylife
 */

import { createTools } from './tools/index.js'
import { ensureWorkspace, resolveRoot } from './lib/store.js'

export const name = 'mylife'

/** 只依赖工具注册表；其余能力（文件、会话）走 Node 原生 API。 */
export const inject = ['tools']

/**
 * 挂载 MyLife。
 *
 * 挂载是**副作用**，会随插件卸载自动撤销（这是 dsh 的插件模型）。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} [config] - 插件配置
 */
export function apply(ctx, config = {}) {
  const cfg = { ...config }
  const root = resolveRoot(cfg)
  cfg.config = cfg

  // 注册全部工具。命名空间统一前缀 mylife_，避免与第一方工具冲突
  // （保留名 run_code 不在此列；同层重名会让注册失败）。
  const tools = createTools(cfg)
  for (const tool of tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      execute: async (args) => executeTool(tool.name, args, cfg),
    })
  }

  // 工作区按需初始化。失败只警告，不能阻止 harness 启动
  // —— 依赖缺失时的"优雅降级"是硬要求（见 ROADMAP 第 9 节）。
  ensureWorkspace(root).catch((err) => {
    ctx.logger?.warn?.(`[mylife] 工作区初始化失败（功能将不可用）：${err?.message ?? err}`)
  })

  ctx.logger?.info?.(`[mylife] 已挂载，工作区：${root}，工具数：${tools.length}`)
}

/**
 * 工具执行分发。
 *
 * 单独成函数以便单测直接调用，不必启动整个 harness。
 *
 * @param {string} toolName - 工具名
 * @param {object} args - 参数
 * @param {object} cfg - 插件配置（config 指向自身）
 */
export async function executeTool(toolName, args = {}, cfg = {}) {
  const { execute } = await import('./tools/execute.js')
  return execute(toolName, args, cfg.config ?? cfg)
}
