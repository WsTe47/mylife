/**
 * MyLife · tool executor
 *
 * 把工具名 + 参数映射到 store / fields / evidence 的调用。
 * 单独成模块，是为了**不必启动整个 harness 就能端到端测试整条链**。
 *
 * @module dsh-mylife/tools/execute
 */

import {
  addClaim,
  addConclusion,
  queryClaims,
  readDigest,
  readIndex,
  readProfile,
  recordRaw,
  setProfileField,
  supersedeClaim,
  traceClaim,
  writeDigest,
} from '../lib/store.js'
import { checkStaleness, fieldFreshness, inferTtlDays } from '../lib/fields.js'
import { buildCounterEvidence } from '../lib/evidence.js'
import { buildDefeaterAnalysis, renderDefeaterReport } from '../lib/defeater.js'
import { createLlm } from '../lib/llm.js'
import { readTextOrNull, layout, resolveRoot } from '../lib/workspace.js'

/**
 * 执行一个 MyLife 工具。
 *
 * @param {string} toolName - 工具名（含 mylife_ 前缀）
 * @param {object} args - 工具参数
 * @param {object} config - 插件配置
 * @returns {Promise<object>} 规范值（由 tools/index.js 的 render 呈现）
 */
export async function execute(toolName, args = {}, config = {}) {
  switch (toolName) {
    // ── 采集层 ──────────────────────────────────────────────
    case 'mylife_record':
      return recordRaw({
        text: args.text,
        topic: args.topic,
        source: args.source,
        config,
      })

    case 'mylife_digest':
      return writeDigest({
        topic: args.topic,
        revised: args.revised,
        aiDraft: args.ai_draft,
        provenance: args.provenance,
        config,
      })

    // ── 认知层 ──────────────────────────────────────────────
    case 'mylife_claim_add':
      return addClaim({
        claim: args.claim,
        topic: args.topic,
        kind: args.kind,
        source: args.source,
        provenance: args.provenance,
        excerpt: args.excerpt,
        context: args.context,
        confidence: args.confidence,
        occurredAt: args.occurred_at,
        config,
      })

    case 'mylife_claim_query':
      return queryClaims({
        topic: args.topic,
        text: args.text,
        status: args.status,
        config,
      })

    case 'mylife_trace':
      return traceClaim({ id: args.id, pad: args.pad, config })

    case 'mylife_counter_evidence': {
      const all = await queryClaims({ status: 'all', config })
      return buildCounterEvidence({ claims: all, topic: args.topic })
    }

    case 'mylife_supersede':
      return supersedeClaim({
        id: args.id,
        reason: args.reason,
        supersededBy: args.superseded_by,
        config,
      })

    case 'mylife_conclusion_add':
      return addConclusion({
        statement: args.statement,
        claimIds: args.claim_ids,
        config,
      })

    // ── 档案与时效 ──────────────────────────────────────────
    case 'mylife_profile_set': {
      const ttlDays =
        args.ttl_days === undefined ? inferTtlDays(args.field) : args.ttl_days
      return setProfileField({
        field: args.field,
        value: args.value,
        source: args.source ?? 'user_filled',
        ttlDays,
        dependsOn: args.depends_on,
        provenance: args.provenance,
        config,
      })
    }

    case 'mylife_staleness_check': {
      const fields = await readProfile({ config })
      const result = checkStaleness({ fields, decision: args.decision })
      return { ...result, promptPreview: null }
    }

    // ── 证伪链（反证主路径）─────────────────────────────────
    case 'mylife_defeaters': {
      // 语料来源：显式传入，或从工作区的 raw/ 里取指定文件（或全部）
      let corpus = args.corpus
      if (!corpus) {
        corpus = await loadCorpus(args.file, config)
      }
      if (!corpus) {
        throw new Error(
          'mylife_defeaters: 没有可用语料。请传 corpus，或传 file（工作区内的相对路径），' +
            '或先用 mylife_record 存入原文（之后不传 file 会用 raw/ 下全部内容）。',
        )
      }
      const llm = args._llm ?? (await createLlm(config))
      // **闭环的关键**：把结构化档案作为"已知事实"一并送去检索。
      // 否则用户补了存款/收入，证伪链仍然报"空白" —— 补了也认不出来。
      const facts = await readProfile({ config })
      const analysis = await buildDefeaterAnalysis({
        proposition: args.proposition,
        corpus,
        facts,
        llm,
      })
      const filled = Object.entries(facts).filter(
        ([, v]) => v?.value !== null && v?.value !== undefined && v?.value !== '',
      )
      return {
        ...analysis,
        rendered: renderDefeaterReport(analysis),
        corpusChars: corpus.length,
        factsUsed: filled.map(([k]) => k),
      }
    }

    // ── 开场简报 ────────────────────────────────────────────
    case 'mylife_status':
      return buildStatus(config)

    default:
      throw new Error(`mylife: 未知工具 ${toolName}`)
  }
}

/**
 * 生成"我现在的状态"简报。
 *
 * 这是给会话开场用的：让 agent 一上来就知道档案里有什么、
 * 哪些信息可能已过时、有哪些未解的张力。**它替代了"往系统提示词里塞状态"**
 * 的做法 —— 后者依赖 PromptAssembly 的内部结构，风险高且不可测。
 *
 * @param {object} config - 插件配置
 */
export async function buildStatus(config = {}) {
  const fields = await readProfile({ config })
  const fieldNames = Object.keys(fields ?? {})

  // 逐字段时效
  const freshness = fieldNames.map((f) => ({
    field: f,
    value: fields[f].value,
    source: fields[f].source ?? 'unknown',
    updated_at: fields[f].updated_at ?? null,
    ...fieldFreshness(fields[f]),
  }))
  const stale = freshness.filter((f) => f.state === 'stale')
  const expiring = freshness.filter((f) => f.state === 'expiring')

  // ⚠️ 关键：从未填写的字段必须被报出来。
  //
  // 早先这里只过滤 stale / expiring，于是 `value: null` 的占位字段**完全隐形** ——
  // agent 看到"档案字段 9 个、无过期字段"就以为数据齐全，
  // 而真实情况是这个决策正卡在 5 处空白上。
  //
  // 这与"证伪链看不到结构化档案"是同一类缺陷：**状态投影没有反映真实状态。**
  // 空白不是"没问题"，它就是问题本身。
  const unset = freshness.filter((f) => f.state === 'unset')

  const active = await queryClaims({ status: 'active', config })
  const retired = await queryClaims({ status: 'superseded', config })
  const disputed = await queryClaims({ status: 'disputed', config })
  const index = await readIndex({ config })

  const topics = [...new Set(active.map((c) => c.topic))].sort()

  // 逐个决策字段算：它的依赖里还缺什么、有没有过期。
  // 这是"决策卡在哪"的直接答案，而不是让 agent 自己拼。
  const decisions = fieldNames
    .filter((f) => Array.isArray(fields[f]?.depends_on) && fields[f].depends_on.length)
    .map((f) => {
      const r = checkStaleness({ fields, decision: f })
      return {
        field: f,
        value: fields[f].value,
        unset: r.unset.map((x) => x.field),
        stale: r.blocking.map((x) => x.field),
        decidable: r.unset.length === 0 && r.blocking.length === 0,
      }
    })

  return {
    workspace: config.workspaceRoot ?? null,
    fields: { total: fieldNames.length, stale, expiring, unset },
    decisions,
    /** 有没有决策正卡在空白上 */
    blockedDecisions: decisions.filter((d) => !d.decidable),
    claims: {
      active: active.length,
      superseded: retired.length,
      disputed: disputed.length,
      topics,
    },
    conclusions: (index.conclusions ?? []).length,
    /** 无依据的证据 —— 它们不该被当作事实使用 */
    unsourcedClaims: active.filter((c) => !c.provenance).map((c) => c.id),
    hasAnything: fieldNames.length > 0 || active.length > 0,
  }
}

/**
 * 取语料。
 *
 * @param {string} [file] - 工作区内的相对路径
 * @param {object} config
 * @returns {Promise<string|null>}
 */
async function loadCorpus(file, config) {
  const root = resolveRoot(config)
  const l = layout(root)
  if (file) {
    return readTextOrNull(pathJoin(root, file))
  }
  // 未指定文件：把 raw/ 下全部原文拼起来（L0 就是语料）
  const { promises: fs } = await import('node:fs')
  const path = await import('node:path')
  let names = []
  try {
    names = (await fs.readdir(l.raw)).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return null
  }
  if (!names.length) return null
  const parts = []
  for (const n of names) {
    const t = await readTextOrNull(path.join(l.raw, n))
    if (t) parts.push(t)
  }
  return parts.length ? parts.join('\n\n') : null
}

function pathJoin(root, rel) {
  return rel.startsWith('/') ? rel : `${root}/${rel}`
}

/** 读取某主题摘要（供 Skill 或 UI 使用）。 */
export async function getDigest(topic, config = {}) {
  return readDigest({ topic, config })
}
