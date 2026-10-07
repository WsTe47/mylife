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
import {
  draftQuestion,
  interpretAnswer,
  pendingItems,
  planProfileUpdates,
} from '../lib/pending.js'
import { diffSnapshots, renderComparison, snapshotState } from '../lib/compare.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeText } from '../lib/workspace.js'
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
  return toLosslessJson(await dispatch(toolName, args, config))
}

/**
 * 把工具的规范值收敛到无损 JSON 范围内（兜底，不是替身）。
 *
 * harness 会用 lossless-JSON 校验每个工具的返回值，而 `undefined`、
 * 非有限数、函数等都不是合法 JSON —— 结果里只要出现一个，
 * **整个工具调用**就会失败（dsh-tools 报 "value is not lossless JSON"），
 * 用户什么都看不到，也看不出是哪个字段的锅。
 *
 * 这里只按 JSON.stringify 的既有语义处理 `undefined` 这一种情况：
 *   · 对象里值为 undefined 的键 → 丢掉（JSON 序列化本来就会忽略它）
 *   · 数组里的 undefined        → null（JSON 序列化本来就会这么写）
 * 其它非法值（NaN、Date、类实例、环……）**原样放行**，让 harness 照旧大声报错 ——
 * 兜底不该把所有问题都糊过去。
 *
 * ⚠️ 它只是安全网。某个字段本该有值却算出了 undefined，仍然要修根因，
 * 不要因为这里不再报错就当它没发生。
 *
 * @param {*} value - 工具返回值
 * @returns {*} 保证不含 undefined 的等价值
 */
function toLosslessJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out = value.map((item) => (item === undefined ? null : toLosslessJson(item, seen)))
    seen.delete(value)
    return out
  }
  if (value === null || typeof value !== 'object') {
    // 顶层 undefined 也要变成 null；其余原始值原样交给 harness 判断
    return value === undefined ? null : value
  }
  const proto = Object.getPrototypeOf(value)
  // 只重建纯对象；Date / Map / 类实例等保持原样，由 harness 明确报错
  if (proto !== null && proto !== Object.prototype) return value
  if (seen.has(value)) return value
  seen.add(value)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = toLosslessJson(item, seen)
  }
  seen.delete(value)
  return out
}

/** 工具分发表。返回值由 {@link execute} 统一收敛。 */
async function dispatch(toolName, args = {}, config = {}) {
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
      const ttlInferred = args.ttl_days === undefined
      const ttlDays = ttlInferred ? inferTtlDays(args.field) : args.ttl_days
      const r = await setProfileField({
        field: args.field,
        value: args.value,
        source: args.source ?? 'user_filled',
        ttlDays,
        dependsOn: args.depends_on,
        provenance: args.provenance,
        config,
      })
      // ttl_days 可能是 null（不过期）。`?? null` 保证返回值一定落在
      // 无损 JSON 范围内 —— 见上方 toLosslessJson 的说明。
      return { ...r, ttl_days: r.ttl_days ?? null, ttl_inferred: ttlInferred }
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

    // ── 闭环入口：取空白 / 提问 / 记录回答 ────────────────────
    case 'mylife_pending':
      return buildPending(config, args)

    case 'mylife_ask': {
      const fields = await readProfile({ config })
      const rec = fields[args.field]
      const note = rec?.provenance ?? args.why ?? null
      const base = draftQuestion(args.field, { note })
      // 模板已命中就不花 LLM —— 措辞稳定、零成本、可离线。
      // 只有模板回退（未知字段）且给了 corpus 时才请 LLM 定制。
      const isFallback = base.question.startsWith('「') && base.question.includes('没有依据')
      if (!isFallback || !args.corpus || !args.use_llm) {
        return { ...base, drafted_by: 'template' }
      }
      try {
        const llm = args._llm ?? (await createLlm(config))
        const text = await llm([
          { role: 'system', content:
            '你在帮一个人补全他个人档案里缺的一个字段。基于他的自述原文，' +
            '生成**一句**问他这个字段的追问。要求：\n' +
            '- 用他自己的语境，不要通用套话\n' +
            '- 只问一个信息点\n' +
            '- 不要替他猜答案，不要给建议\n' +
            '- 直接输出那句话，不要解释' },
          { role: 'user', content: `需要补的字段：${args.field}\n\n他的自述：\n${String(args.corpus).slice(0, 12000)}` },
        ], { maxTokens: 200 })
        return { ...base, question: text.trim().replace(/^["「]|["」]$/g, ''), drafted_by: 'llm' }
      } catch (err) {
        return { ...base, drafted_by: 'template', llm_error: err?.message ?? String(err) }
      }
    }

    case 'mylife_answer': {
      const parsed = interpretAnswer(args.answer)
      if (parsed.status === 'answered') {
        // ── 有效期解析：显式参数 > 字段已有 > 按字段名推断 ──────────
        //
        // ⚠️ 这里必须保证 ttl_days 一定有值（数字或 null），绝不能是 undefined。
        // 早先的实现直接把 `args.ttl_days` 透传下去：对一个**档案里还不存在的新字段**，
        // setProfileField 拿到 undefined 就不会写 ttl_days 键，返回对象里也就没有，
        // 于是这里返回的 `{ ..., ttl_days: undefined }` 让 harness 的
        // lossless-JSON 校验直接失败（dsh-tools: "value is not lossless JSON"），
        // **整个工具调用**报错 —— 用户什么都看不到。
        // 已有字段碰巧带着 ttl_days，所以那条路径一直是好的，测试也就没抓到。
        const existing = (await readProfile({ config }))[args.field]
        const ttlInferred = args.ttl_days === undefined && existing?.ttl_days === undefined
        const ttlDays =
          args.ttl_days !== undefined
            ? args.ttl_days
            : existing?.ttl_days !== undefined
              ? existing.ttl_days
              : inferTtlDays(args.field)
        const r = await setProfileField({
          field: args.field,
          value: parsed.value,
          // 用户口述 → user_filled；标明是"回答追问"得来的
          source: 'user_filled',
          ttlDays,
          provenance: `用户在追问中回答（${new Date().toISOString().slice(0, 10)}）`,
          config,
        })
        return {
          field: args.field,
          status: 'answered',
          value: parsed.value,
          ttl_days: r.ttl_days ?? null,
          ttl_inferred: ttlInferred,
        }
      }
      // skipped / unclear：**不写档案**，只如实回报
      return {
        field: args.field,
        status: parsed.status,
        value: null,
        note: parsed.note,
        written: false,
      }
    }

    // ── 闭环：重算对比 ──────────────────────────────────────
    case 'mylife_recompute':
      return recompute({ decision: args.decision, stage: args.stage, config })

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
 * 取全部待办：空白字段 + 卡住的决策 + 现成问句。
 *
 * 这是闭环的第一步 —— 过去没有它，agent 只能自己翻档案猜还缺什么。
 *
 * @param {object} config
 * @param {object} [args]
 */
export async function buildPending(config = {}, args = {}) {
  const fields = await readProfile({ config })
  const status = await buildStatus(config)
  const decision = args.decision ?? null
  const staleness = checkStaleness({ fields, decision })
  const items = pendingItems({
    fields,
    staleness,
    decisions: status.decisions ?? [],
  })
  return { ...items, decision, fieldsTotal: Object.keys(fields).length }
}

/**
 * 重算：与上一次快照对比。
 *
 * 闭环的最后一步 —— 用户补完字段后，必须能看见**到底变了什么**，
 * 否则他不会知道自己刚才那几分钟换来了什么。
 *
 * 快照落在工作区的 `.compare-<decision>.json`（点开头，不进 git）。
 * 首次调用（无旧快照）时只落一份，并如实告知"没有可对比的基线"。
 *
 * @param {object} params
 * @param {string} [params.decision]
 * @param {string} [params.stage] - 覆盖阶段标记
 * @param {object} params.config
 */
export async function recompute({ decision = null, stage = null, config = {} }) {
  const root = resolveRoot(config)
  const key = decision ? decision.replace(/[^\w\u4e00-\u9fff-]/g, '_') : 'all'
  const snapFile = path.join(root, `.compare-${key}.json`)

  const after = await snapshotState({ stage: stage ?? 'after', decision, config })

  let before = null
  try {
    before = JSON.parse(await fs.readFile(snapFile, 'utf8'))
  } catch {
    before = null
  }

  await writeText(snapFile, JSON.stringify(after, null, 2))

  if (!before) {
    return {
      decision,
      baseline: false,
      after,
      rendered:
        `## 已存下基线（决策：${decision ?? '（未指定）'}）\n\n` +
        `这是第一次重算，**没有可对比的基线**。\n` +
        `当前填充覆盖率：${Math.round(ratio(after))}%。\n\n` +
        `补完字段后再调一次本工具，就能看到「填前 → 填后」的差异。`,
    }
  }

  const diff = diffSnapshots(before, after)
  return {
    decision,
    baseline: true,
    before,
    after,
    diff,
    rendered: renderComparison({ before, after, diff }),
  }
}

function ratio(snap) {
  const deps = snap?.dependencies ?? []
  if (!deps.length) return 0
  const filled = new Set(snap.filled ?? [])
  return deps.filter((d) => filled.has(d)).length / deps.length
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
