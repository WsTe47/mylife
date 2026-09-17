/**
 * MyLife · workspace layer
 *
 * 负责：路径解析、四层文件定位、原子写、ID 生成。
 *
 * 设计原则（见 TECH_DESIGN.md 第 3 章）：
 *   - L0 raw/ 只增不改不删 —— 原始输入是不可伪造的证据源
 *   - 所有层都是可读文本，用户可 cat / 可 git
 *   - 写入走临时文件 + rename，避免半截文件
 *
 * @module dsh-mylife/lib/workspace
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 默认工作区（可被配置覆盖）。 */
export const DEFAULT_ROOT = path.join(process.env.HOME ?? '.', 'mylife')

/**
 * 解析工作区根目录。
 *
 * @param {object} [config] - 插件配置
 * @returns {string} 绝对路径
 */
export function resolveRoot(config = {}) {
  const raw = config.workspaceRoot || process.env.MYLIFE_ROOT || DEFAULT_ROOT
  return path.resolve(raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
}

/** 四层文件的相对路径。 */
export const PATHS = {
  raw: 'raw',
  digest: 'digest',
  /** L2：一条证据一个文件，永不冲突 */
  claims: 'claims',
  /** L2 子索引：由 claims/*.md 重建，可安全删除 */
  claimIndex: 'claims/index.yaml',
  /** L3：档案字段 + 逐字段时效 */
  profile: 'profile.yaml',
  /** L4：溯源链（结论 → 依据 claim → 原文）与话题分支 */
  trace: 'index.yaml',
  /** 字段词典（不预制，按需生长） */
  fields: 'fields.yaml',
}

/**
 * 给定工作区根，返回各层的绝对路径。
 *
 * @param {string} root - 工作区根
 */
export function layout(root) {
  const abs = (p) => path.join(root, p)
  return {
    root,
    raw: abs(PATHS.raw),
    digest: abs(PATHS.digest),
    claims: abs(PATHS.claims),
    claimIndex: abs(PATHS.claimIndex),
    profile: abs(PATHS.profile),
    trace: abs(PATHS.trace),
    fields: abs(PATHS.fields),
  }
}

/**
 * 确保工作区骨架存在。可反复调用（幂等）。
 *
 * @param {string} root - 工作区根
 */
export async function ensureWorkspace(root) {
  const l = layout(root)
  await fs.mkdir(l.raw, { recursive: true })
  await fs.mkdir(l.digest, { recursive: true })
  await fs.mkdir(path.dirname(l.claims), { recursive: true })
  return l
}

/**
 * 原子写文本：先写临时文件再 rename，避免读到半截内容。
 *
 * @param {string} file - 目标绝对路径
 * @param {string} text - 内容
 */
export async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * 读文本；不存在返回 null（区别于空文件）。
 *
 * @param {string} file - 目标绝对路径
 * @returns {Promise<string|null>}
 */
export async function readTextOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * 读 JSON；不存在或损坏返回 fallback。
 *
 * @param {string} file - 目标绝对路径
 * @param {*} fallback - 兜底值
 */
export async function readJsonOr(file, fallback) {
  const text = await readTextOrNull(file)
  if (text === null || text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 生成带日期与序号的稳定 ID。
 *
 * 形如 `2026-09-17-003`，同一天多次写入递增，便于人工排序与引用。
 *
 * @param {string[]} existing - 已存在的 ID 列表
 * @param {Date} [now] - 当前时间
 * @returns {string}
 */
export function nextId(existing, now = new Date()) {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const used = new Set(
    (existing ?? [])
      .filter((id) => typeof id === 'string' && id.startsWith(day))
      .map((id) => Number.parseInt(id.slice(day.length + 1), 10))
      .filter(Number.isFinite),
  )
  let n = 1
  while (used.has(n)) n += 1
  return `${day}-${String(n).padStart(3, '0')}`
}

/**
 * 判断路径是否落在工作区内（防目录穿越）。
 *
 * @param {string} root - 工作区根
 * @param {string} candidate - 待检查路径
 * @returns {boolean}
 */
export function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 工作区是否已初始化。
 *
 * @param {string} root - 工作区根
 */
export function isInitialized(root) {
  return existsSync(layout(root).claims) || existsSync(layout(root).profile)
}
