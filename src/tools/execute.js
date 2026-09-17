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

  const active = await queryClaims({ status: 'active', config })
  const retired = await queryClaims({ status: 'superseded', config })
  const disputed = await queryClaims({ status: 'disputed', config })
  const index = await readIndex({ config })

  const topics = [...new Set(active.map((c) => c.topic))].sort()

  return {
    workspace: config.workspaceRoot ?? null,
    fields: { total: fieldNames.length, stale, expiring },
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

/** 读取某主题摘要（供 Skill 或 UI 使用）。 */
export async function getDigest(topic, config = {}) {
  return readDigest({ topic, config })
}
