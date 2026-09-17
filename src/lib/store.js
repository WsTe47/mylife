/**
 * MyLife · store layer
 *
 * 四层信息模型的读写。这是 MyLife 唯一真正的"自有数据格式"，
 * 也是全部价值的地基（见 TECH_DESIGN.md 第 3 章）。
 *
 * 层级职责：
 *   L0 raw/       原始输入，只增不改不删 —— 不可伪造的证据源
 *   L1 digest/    按主题整理的摘要，可重新生成；同时保留 AI 原稿与用户修订版
 *   L2 claims/    证据图：一条证据一个文件（永不冲突），另有可重建的 index.yaml
 *   L3 profile.yaml + fields.yaml  当前状态 + 逐字段时效（TTL）
 *   L4 index.yaml 溯源链：结论 → claim → 原文（文件 + 行号）
 *
 * 设计取舍：claims 采用"一条一文件"而非单一大数组。
 * 理由与 awesome-dsh-plugin 相同：单点追加会让每次编辑都互相冲突，分离文件永不冲突。
 *
 * @module dsh-mylife/lib/store
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ensureWorkspace,
  layout,
  nextId,
  readTextOrNull,
  resolveRoot,
  writeText,
} from './workspace.js'
import { joinFrontmatter, parseObject, splitFrontmatter, stringify } from './yaml.js'

/** 证据的性质。assessment 不是二等公民——它常是决策真正的难点。 */
export const CLAIM_KINDS = ['fact', 'assessment', 'inference', 'unknown']

/** 证据的来源。用于降权判断与可追溯性。 */
export const CLAIM_SOURCES = [
  'user_raw',      // 用户原始输入（最高可信）
  'user_filled',   // 用户手填的结构化字段
  'bill_import',   // 账单等导入
  'mcp',           // 外部 MCP 提供
  'llm_inferred',  // AI 推断（最低可信，必须显式标注）
]

/** claim 生命周期状态。 */
export const CLAIM_STATUS = ['active', 'stale', 'superseded', 'disputed']

/** 不过期的哨兵值。 */
export const NO_EXPIRY = null

const CLAIMS_HEADER =
  'MyLife 证据索引（由 store 自动重建，可安全删除）。每条证据的正文在 claims/<id>.md'

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

/** 读取某目录下所有文件名（不存在则空数组）。 */
async function listFiles(dir, filter) {
  try {
    const names = await fs.readdir(dir)
    return filter ? names.filter(filter) : names
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

/** 读取全部 claim 文件，返回 {id, ...frontmatter, excerpt} 列表。 */
async function readAllClaims(root) {
  const l = layout(root)
  const files = await listFiles(l.claims, (n) => n.endsWith('.md'))
  const claims = []
  for (const name of files.sort()) {
    const text = await readTextOrNull(path.join(l.claims, name))
    if (text === null) continue
    const { data } = splitFrontmatter(text)
    if (data && typeof data.id === 'string') claims.push(data)
  }
  return claims
}

/** 重建 claims/index.yaml。任何时候都可安全重跑。 */
async function rebuildClaimIndex(root) {
  const l = layout(root)
  const claims = await readAllClaims(root)
  const rows = claims
    .sort((a, b) => String(a.occurred_at ?? '').localeCompare(String(b.occurred_at ?? '')))
    .map((c) => ({
      id: c.id,
      topic: c.topic,
      kind: c.kind,
      source: c.source,
      occurred_at: c.occurred_at,
      status: c.status ?? 'active',
      confidence: c.confidence ?? null,
    }))
  await writeText(l.claimIndex, stringify(rows, CLAIMS_HEADER))
  return rows
}

/** 组装 claim 的 Markdown 正文。 */
function renderClaim(claim) {
  const quote = claim.excerpt
    ? `\n## 原始表述\n\n> ${String(claim.excerpt).replace(/\n/g, '\n> ')}\n`
    : ''
  const note = claim.note ? `\n## 说明\n\n${claim.note}\n` : ''
  return joinFrontmatter(claim, `# ${claim.claim}\n${quote}${note}`)
}

/**
 * 记录一次来源指针。溯源链的最小单元。
 *
 * @param {string} file - 相对工作区的文件路径
 * @param {number|null} line - 起始行号（1 基）
 * @param {number|null} endLine - 结束行号
 */
export function makeProvenance(file, line, endLine) {
  const range = line ? (endLine && endLine !== line ? `${line}-${endLine}` : `${line}`) : null
  return range ? `${file}#L${range}` : file
}

/** 解析溯源指针 `file#L1-5` → {file, line, endLine}。 */
export function parseProvenance(pointer) {
  if (typeof pointer !== 'string' || pointer === '') return null
  const m = /^(.*?)#L(\d+)(?:-(\d+))?$/.exec(pointer)
  if (!m) return { file: pointer, line: null, endLine: null }
  return {
    file: m[1],
    line: Number.parseInt(m[2], 10),
    endLine: m[3] ? Number.parseInt(m[3], 10) : Number.parseInt(m[2], 10),
  }
}

// ─────────────────────────────────────────────────────────────
// L0 / L1
// ─────────────────────────────────────────────────────────────

/**
 * 把原始输入存入 L0。**永不修改既有内容。**
 *
 * @param {object} params
 * @param {string} params.text - 原始文本（允许错别字、语病、情绪化重复）
 * @param {string} [params.topic] - 主题标签（仅用于文件名与索引，不改动正文）
 * @param {string} [params.source] - 输入方式：voice | text | paste | import
 * @param {string} [params.config] - 插件配置
 * @returns {Promise<{id: string, file: string, lines: number}>}
 */
export async function recordRaw({ text, topic = 'misc', source = 'text', config = {} }) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('recordRaw: text 不能为空')
  }
  const root = resolveRoot(config)
  const l = await ensureWorkspace(root)

  const existing = await listFiles(l.raw, (n) => n.endsWith('.md'))
  const stamp = new Date()
  const day = [
    stamp.getFullYear(),
    String(stamp.getMonth() + 1).padStart(2, '0'),
    String(stamp.getDate()).padStart(2, '0'),
  ].join('-')
  const sameDay = existing.filter((n) => n.startsWith(day))
  let n = sameDay.length + 1
  let file = `raw/${day}-${String(n).padStart(3, '0')}-${slug(topic)}.md`
  while (existing.includes(path.basename(file))) {
    n += 1
    file = `raw/${day}-${String(n).padStart(3, '0')}-${slug(topic)}.md`
  }
  // 元信息头。正文紧跟其后 —— 行号必须精确可算，否则溯源会指错行。
  const headLines = [
    `# 原始输入 ${day}`,
    '',
    `- 记录时间：${stamp.toISOString()}`,
    `- 主题：${topic}`,
    `- 输入方式：${source}`,
    '',
    '> 本文为 L0 原始层：一字不改地保留，作为不可伪造的证据源。',
    '',
  ]
  const head = headLines.join('\n')
  const body = `${head}${text.trimEnd()}\n`
  await writeText(path.join(root, file), body)

  const allLines = body.split('\n')
  const lines = allLines.length

  // 正文的精确行区间。**这是溯源能否指对行的关键**：
  // 调用方（agent）必须拿到它，否则只能猜行号，而猜错会让"每条判断可溯源"
  // 这个核心承诺失效（实测中就发生过：正文在第 8 行，agent 猜了第 9 行的空行）。
  const startLine = headLines.length // 头末尾的空串让正文落在下一行
  const textLineCount = text.trimEnd().split('\n').length
  const endLine = startLine + textLineCount - 1

  return {
    id: path.basename(file, '.md'),
    file,
    lines,
    startLine,
    endLine,
    /** 可直接用于 claim.provenance 的指针 */
    provenance: makeProvenance(file, startLine, endLine),
  }
}

/**
 * 文件名安全化。
 *
 * 保留中文，但必须彻底消除路径穿越风险：`../evil/path` 不能变成含 `..` 的名字。
 * 做法：先把任意长度的点号折叠成单个连字符，再替换其它危险字符。
 */
export function slug(s) {
  const out = String(s ?? 'misc')
    .trim()
    .replace(/\.{1,}/g, '-')            // 折叠点号：消除 `..` 与隐藏文件前缀
    .replace(/[\/\\:*?"<>|\s]+/g, '-') // 路径分隔与保留字符
    .replace(/^[-.]+|[-.]+$/g, '')       // 去首尾分隔符
    .slice(0, 40)
  return out === '' || out.includes('..') ? 'misc' : out
}

/**
 * 写入/更新某主题的 L1 摘要。
 *
 * **同时保留 AI 原稿与用户修订版**（你的决定：默认开启并标注差异）。
 * 理由：能发现"AI 转述与你本意有偏差"，而这个偏差本身是校准系统的原料。
 *
 * @param {object} params
 * @param {string} params.topic - 主题
 * @param {string} params.revised - 用户确认/修订后的表述
 * @param {string} [params.aiDraft] - AI 原始输出（未修订时省略）
 * @param {string[]} [params.provenance] - 依据的 L0 指针列表
 * @param {object} [params.config]
 */
export async function writeDigest({ topic, revised, aiDraft, provenance = [], config = {} }) {
  const root = resolveRoot(config)
  const l = await ensureWorkspace(root)
  const file = path.join(l.digest, `${slug(topic)}.md`)

  const previous = await readTextOrNull(file)
  const prev = previous ? splitFrontmatter(previous) : { data: {}, body: '' }
  const now = new Date().toISOString()

  const data = {
    topic,
    updated_at: now,
    created_at: prev.data?.created_at ?? now,
    revisions: (prev.data?.revisions ?? 0) + 1,
    provenance,
    ...(aiDraft ? { ai_draft: aiDraft } : prev.data?.ai_draft ? { ai_draft: prev.data.ai_draft } : {}),
    divergent: Boolean(aiDraft ?? prev.data?.ai_draft) && revised.trim() !== String(aiDraft ?? prev.data?.ai_draft ?? '').trim(),
  }

  const body = [
    '# 摘要（用户确认版）',
    '',
    revised.trim(),
    '',
    '---',
    '',
    '<!-- 以下是 AI 原稿，仅作偏差比对之用；真正生效的是上面的用户确认版。 -->',
    '',
    '## AI 原稿',
    '',
    (aiDraft ?? prev.data?.ai_draft ?? '（无）').trim(),
    '',
  ].join('\n')

  await writeText(file, joinFrontmatter(data, body))
  return { topic, file: `digest/${slug(topic)}.md`, revisions: data.revisions, divergent: data.divergent }
}

/** 读取某主题的摘要。 */
export async function readDigest({ topic, config = {} }) {
  const l = layout(resolveRoot(config))
  const text = await readTextOrNull(path.join(l.digest, `${slug(topic)}.md`))
  if (text === null) return null
  const { data, body } = splitFrontmatter(text)
  return { ...data, body }
}

// ─────────────────────────────────────────────────────────────
// L2 证据图
// ─────────────────────────────────────────────────────────────

/**
 * 新增一条证据。
 *
 * @param {object} params
 * @param {string} params.claim - 证据内容（一句话）
 * @param {string} params.topic - 主题聚簇键（反证引擎按它聚合）
 * @param {string} [params.kind] - fact | assessment | inference | unknown
 * @param {string} [params.source] - 见 CLAIM_SOURCES
 * @param {string} [params.provenance] - `file#L1-5` 形式
 * @param {string} [params.excerpt] - 用户原话摘录
 * @param {string} [params.context] - 当时的语境（还原用，非指控）
 * @param {string} [params.confidence] - high | medium | low
 * @param {string} [params.occurredAt] - 该表述发生的时间（默认今天）
 * @param {string} [params.note]
 * @param {object} [params.config]
 */
export async function addClaim({
  claim,
  topic,
  kind = 'assessment',
  source = 'user_raw',
  provenance = null,
  excerpt = null,
  context = null,
  confidence = 'medium',
  occurredAt = null,
  note = null,
  config = {},
}) {
  if (!claim || !topic) throw new Error('addClaim: claim 与 topic 必填')
  if (!CLAIM_KINDS.includes(kind)) throw new Error(`addClaim: kind 必须是 ${CLAIM_KINDS.join(' | ')}`)
  if (!CLAIM_SOURCES.includes(source)) throw new Error(`addClaim: source 必须是 ${CLAIM_SOURCES.join(' | ')}`)

  const root = resolveRoot(config)
  const l = await ensureWorkspace(root)
  const existing = await readAllClaims(root)
  const id = nextId(existing.map((c) => c.id))

  const record = {
    id,
    topic,
    claim: String(claim).trim(),
    kind,
    source,
    provenance,
    excerpt,
    occurred_at: occurredAt ?? new Date().toISOString().slice(0, 10),
    context,
    confidence,
    status: 'active',
    superseded_by: null,
    note,
  }

  await writeText(path.join(l.claims, `${id}.md`), renderClaim(record))
  await rebuildClaimIndex(root)
  return record
}

/** 按主题（模糊）/关键词/状态检索证据。 */
export async function queryClaims({ topic = null, text = null, status = 'active', config = {} } = {}) {
  const root = resolveRoot(config)
  const all = await readAllClaims(root)
  const needle = text ? String(text).toLowerCase() : null
  return all.filter((c) => {
    if (status && status !== 'all' && (c.status ?? 'active') !== status) return false
    if (topic && !String(c.topic ?? '').includes(topic)) return false
    if (needle) {
      const hay = `${c.claim ?? ''} ${c.excerpt ?? ''} ${c.context ?? ''} ${c.note ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

/**
 * 作废一条证据（旧前提作废）。
 *
 * 这是"人的旧约束会自动在心里失效，但 AI 会一直记着"问题的解药。
 * 必须给出理由 —— 与 Memorix 的 supersede 同样强制。
 *
 * @param {object} params
 * @param {string} params.id - 目标 claim id
 * @param {string} params.reason - 为什么它不再成立（必填）
 * @param {string} [params.supersededBy] - 取代它的新 claim id
 * @param {object} [params.config]
 */
export async function supersedeClaim({ id, reason, supersededBy = null, config = {} }) {
  if (!id || !reason) throw new Error('supersedeClaim: id 与 reason 必填')
  const root = resolveRoot(config)
  const l = await ensureWorkspace(root)
  const file = path.join(l.claims, `${id}.md`)
  const text = await readTextOrNull(file)
  if (text === null) throw new Error(`supersedeClaim: 找不到 ${id}`)

  const { data, body } = splitFrontmatter(text)
  const updated = {
    ...data,
    status: supersededBy ? 'superseded' : 'disputed',
    superseded_by: supersededBy,
    retired_at: new Date().toISOString().slice(0, 10),
    retire_reason: reason,
  }
  const extra = `\n## 作废记录\n\n- 时间：${updated.retired_at}\n- 原因：${reason}\n${supersededBy ? `- 取代者：${supersededBy}\n` : ''}`
  await writeText(file, joinFrontmatter(updated, `${body}${extra}`))
  await rebuildClaimIndex(root)
  return updated
}

/**
 * 溯源：把一条 claim 还原到 L0 原文（带真实行号与原文内容）。
 *
 * 这是"没有依据就不许输出"的技术实现 —— 它让"引不出出处"变成可检测的事实。
 *
 * @param {object} params
 * @param {string} params.id - claim id
 * @param {number} [params.pad] - 前后各多取几行
 * @param {object} [params.config]
 */
export async function traceClaim({ id, pad = 0, config = {} }) {
  const root = resolveRoot(config)
  const l = layout(root)
  const claim = (await readAllClaims(root)).find((c) => c.id === id)
  if (!claim) throw new Error(`traceClaim: 找不到 ${id}`)
  if (!claim.provenance) {
    return { id, traced: false, reason: '该证据没有记录来源指针，无法溯源', claim }
  }

  const ptr = parseProvenance(claim.provenance)
  const abs = path.join(root, ptr.file)
  const text = await readTextOrNull(abs)
  if (text === null) {
    return { id, traced: false, reason: `来源文件不存在：${ptr.file}`, claim, provenance: claim.provenance }
  }
  const all = text.split('\n')
  const from = Math.max(1, (ptr.line ?? 1) - pad)
  const to = Math.min(all.length, (ptr.endLine ?? ptr.line ?? 1) + pad)
  const slice = all.slice(from - 1, to).map((line, i) => ({ line: from + i, text: line }))

  return {
    id,
    traced: true,
    claim,
    provenance: claim.provenance,
    file: ptr.file,
    range: `${from}-${to}`,
    lines: slice,
  }
}

export { layout, resolveRoot, ensureWorkspace, readAllClaims, rebuildClaimIndex }

// ─────────────────────────────────────────────────────────────
// L3 档案与时效
// ─────────────────────────────────────────────────────────────

const PROFILE_HEADER =
  'MyLife 档案层：可过期的个人状态。每个字段必须带 value / source / updated_at；ttl_days 为 null 表示永不过期。'

/** 读取档案字段表。 */
export async function readProfile({ config = {} } = {}) {
  const l = layout(resolveRoot(config))
  const text = await readTextOrNull(l.profile)
  const fields = parseObject(text, {})
  return fields.fields ?? fields
}

/**
 * 写入/更新一个档案字段。
 *
 * `dependsOn` 是"信息维护"机制的关键：它记录**这个决策依赖哪些字段**。
 * 由于我们不预制字段词典，依赖关系必须由运行时（agent 创建决策时）声明，
 * 时效检查再据此递归展开。这既保持开放，又不丢失时效能力。
 *
 * @param {object} params
 * @param {string} params.field - 字段名
 * @param {*} params.value - 值
 * @param {string} [params.source] - user_filled | bill_import | mcp | user_raw
 * @param {number|null} [params.ttlDays] - 有效期天数；null = 不过期
 * @param {string[]} [params.dependsOn] - 本字段的结论依赖哪些其它字段
 * @param {string} [params.provenance]
 * @param {object} [params.config]
 */
export async function setProfileField({
  field,
  value,
  source = 'user_filled',
  ttlDays = undefined,
  dependsOn = undefined,
  provenance = null,
  config = {},
}) {
  if (!field) throw new Error('setProfileField: field 必填')
  const root = resolveRoot(config)
  const l = await ensureWorkspace(root)
  const fields = await readProfile({ config })
  const prev = fields[field] ?? {}
  const next = {
    ...prev,
    value,
    source,
    updated_at: new Date().toISOString().slice(0, 10),
    ...(ttlDays !== undefined ? { ttl_days: ttlDays } : {}),
    ...(dependsOn !== undefined ? { depends_on: dependsOn } : {}),
    ...(provenance ? { provenance } : {}),
  }
  fields[field] = next
  await registerFieldInDictionary({ root, field, ttlDays: next.ttl_days, dependsOn: next.depends_on })
  await writeText(l.profile, stringify({ fields }, PROFILE_HEADER))
  return { field, ...next }
}

const FIELDS_HEADER =
  'MyLife 字段词典（按需生长，非预制）。ttl_source=inferred 表示该有效期是系统推断的，待用户确认。'

/**
 * 把字段登记进 fields.yaml（字段词典）。
 *
 * 词典是**生长出来的**，不是预制死的：用户聊到什么就有什么。
 * `ttl_source=inferred` 标记该有效期是系统猜的而不是用户确认的 —— 便于后续区分可信度。
 */
async function registerFieldInDictionary({ root, field, ttlDays, dependsOn }) {
  const l = layout(root)
  const text = await readTextOrNull(l.fields)
  const dict = parseObject(text, {})
  const fields = dict.fields ?? {}
  const existing = fields[field]
  fields[field] = {
    ...(existing ?? {}),
    ttl_days: ttlDays ?? null,
    ttl_source: existing?.ttl_source ?? 'inferred',
    depends_on: dependsOn ?? existing?.depends_on ?? [],
    first_seen: existing?.first_seen ?? new Date().toISOString().slice(0, 10),
  }
  await writeText(l.fields, stringify({ fields }, FIELDS_HEADER))
}

// ─────────────────────────────────────────────────────────────
// L4 溯源索引
// ─────────────────────────────────────────────────────────────

const INDEX_HEADER = 'MyLife 溯源索引：结论 → 依据 claim → 原文。由 store 维护。'

/** 读取 index.yaml。 */
export async function readIndex({ config = {} } = {}) {
  const l = layout(resolveRoot(config))
  const text = await readTextOrNull(l.trace)
  return parseObject(text, { conclusions: [], branches: [] })
}

/** 追加一条"结论 → 依据"的溯源记录。 */
export async function addConclusion({ statement, claimIds, config = {} }) {
  if (!statement) throw new Error('addConclusion: statement 必填')
  const root = resolveRoot(config)
  const l = await ensureWorkspace(root)
  const index = await readIndex({ config })
  const conclusions = Array.isArray(index.conclusions) ? index.conclusions : []
  const entry = {
    id: `concl-${new Date().toISOString().slice(0, 10)}-${conclusions.length + 1}`,
    statement,
    claim_ids: claimIds ?? [],
    created_at: new Date().toISOString(),
  }
  conclusions.push(entry)
  await writeText(l.trace, stringify({ ...index, conclusions }, INDEX_HEADER))
  return entry
}
