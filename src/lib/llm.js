/**
 * MyLife · LLM adapter
 *
 * 一个很薄的 DeepSeek 适配器。**刻意只做一件事**：把 messages 变成文本。
 *
 * 为什么不 import dsh 的内部 LLM：
 *   本插件装在 profile 之外，解析不到 `@deepseek-ai/*`（实测 MODULE_NOT_FOUND）。
 *   而"不依赖任何 dsh 包"正是本插件能在任何布局下加载的原因。
 *   所以直接用 fetch 打 HTTP，比依赖一条解析不到的 import 可靠。
 *
 * API key 的取法（按优先级）：
 *   1. 插件配置 llm.apiKey
 *   2. 环境变量 DEEPSEEK_API_KEY
 *   3. ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY
 *
 * 注意：第 3 条是 dsh 自己的凭据文件格式，属于**便利回退**，不是稳定接口。
 * 生产环境建议用前两条。
 *
 * @module dsh-mylife/lib/llm
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxTokens: 2000,
  temperature: 0.2,
  timeoutMs: 120000,
}

/**
 * 读取 dsh 凭据文件里的 DeepSeek key。
 *
 * 自己写一个极小的 YAML 取值，而不是依赖 js-yaml：
 * 这里只需要从 `refs:` 段取一行，不值得为此引入解析器的行为差异。
 *
 * @param {string} [home]
 * @returns {Promise<string|null>}
 */
export async function readKeyFromDshCredentials(home = os.homedir()) {
  const file = path.join(home, '.dsh', '.credentials.yaml')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  // 形如：  DEEPSEEK_API_KEY: sk-xxxx
  const m = /^\s*DEEPSEEK_API_KEY:\s*["']?([^"'\s#]+)["']?\s*$/m.exec(text)
  return m ? m[1] : null
}

/**
 * 解析 LLM 配置。
 *
 * @param {object} [config] - 插件配置（读 config.llm）
 * @returns {Promise<{apiKey: string|null, baseUrl: string, model: string, maxTokens: number, temperature: number, timeoutMs: number}>}
 */
export async function resolveLlmConfig(config = {}) {
  const c = config.llm ?? {}
  const apiKey =
    c.apiKey ||
    process.env.DEEPSEEK_API_KEY ||
    (await readKeyFromDshCredentials())
  return {
    apiKey: apiKey ?? null,
    baseUrl: c.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULTS.baseUrl,
    model: c.model || process.env.DEEPSEEK_MODEL || DEFAULTS.model,
    maxTokens: c.maxTokens ?? DEFAULTS.maxTokens,
    temperature: c.temperature ?? DEFAULTS.temperature,
    timeoutMs: c.timeoutMs ?? DEFAULTS.timeoutMs,
  }
}

/**
 * 创建一个 llm 函数：`(messages, opts) => Promise<string>`。
 *
 * 返回的函数就是"依赖注入"里被注入的东西 —— 默认打真实 API，
 * 测试时可以传一个 stub 顶替，因此核心逻辑可以离线单测。
 *
 * @param {object} [config] - 插件配置
 * @returns {Promise<(messages: object[], opts?: object) => Promise<string>>}
 */
export async function createLlm(config = {}) {
  const c = await resolveLlmConfig(config)
  if (!c.apiKey) {
    throw new Error(
      'MyLife 需要 LLM 凭据：请在插件配置里设 llm.apiKey，或设环境变量 DEEPSEEK_API_KEY',
    )
  }

  return async function llm(messages, opts = {}) {
    const wantJson = opts.json === true
    const body = {
      model: opts.model || c.model,
      messages,
      max_tokens: opts.maxTokens ?? c.maxTokens,
      temperature: opts.temperature ?? c.temperature,
      ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? c.timeoutMs)
    let res
    try {
      res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      // 超时与网络错误分开报，便于定位
      if (err?.name === 'AbortError') {
        throw new Error(`LLM 调用超时（${opts.timeoutMs ?? c.timeoutMs}ms）`)
      }
      throw new Error(`LLM 请求失败：${err?.message ?? err}`)
    }
    clearTimeout(timer)

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`LLM 返回 ${res.status}：${detail.slice(0, 300)}`)
    }
    const json = await res.json()
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new Error(`LLM 返回结构异常：${JSON.stringify(json).slice(0, 200)}`)
    }
    return text
  }
}

export { DEFAULTS as LLM_DEFAULTS }
