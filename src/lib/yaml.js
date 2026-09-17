/**
 * MyLife · YAML layer
 *
 * 只做两件事：安全的解析、可读的序列化。
 * 解析失败一律返回兜底值而不是抛出 —— 用户的档案文件可能被手工编辑过，
 * 一个语法错误不应该让整个 agent 崩掉。
 *
 * @module dsh-mylife/lib/yaml
 */

import yaml from 'js-yaml'

/**
 * 解析 YAML；失败返回 fallback。
 *
 * @param {string|null} text - YAML 文本
 * @param {*} [fallback] - 兜底值
 * @returns {*}
 */
export function parse(text, fallback = null) {
  if (typeof text !== 'string' || text.trim() === '') return fallback
  try {
    const value = yaml.load(text)
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** 解析 YAML 并把结果强制视为数组（非数组一律降级为空数组）。 */
export function parseList(text) {
  const value = parse(text, [])
  return Array.isArray(value) ? value : []
}

/** 解析 YAML 并把结果强制视为对象。 */
export function parseObject(text, fallback = {}) {
  const value = parse(text, fallback)
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

/**
 * 序列化为 YAML，带文件头注释。
 *
 * @param {*} value - 待序列化值
 * @param {string} [header] - 顶部注释（不含 `#` 前缀）
 */
export function stringify(value, header) {
  const body = yaml.dump(value, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  })
  return header ? `# ${header}\n${body}` : body
}

/**
 * 从 Markdown 中拆出 YAML frontmatter。
 *
 * @param {string} text - Markdown 全文
 * @returns {{data: object, body: string}}
 */
export function splitFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) {
    return { data: {}, body: text ?? '' }
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  return { data: parseObject(head), body }
}

/**
 * 组装带 frontmatter 的 Markdown。
 *
 * @param {object} data - frontmatter 数据
 * @param {string} body - 正文
 */
export function joinFrontmatter(data, body) {
  const head = yaml.dump(data, { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()
  return `---\n${head}\n---\n\n${body.replace(/^\n+/, '')}`
}
