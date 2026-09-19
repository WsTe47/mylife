/**
 * MyLife · before/after 对比
 *
 * 为什么需要它：
 *   这个产品的核心承诺是"补上空白之后，判断会变得更可靠"。
 *   但那是个**可检验的断言** —— 如果不把"填之前"和"填之后"并排摆出来，
 *   我们就只是在自我宣称有效。
 *
 * 它同时服务两件事：
 *   1. 给用户看：结论变了吗？变得对不对？
 *   2. 给开发者看：这套机制到底有没有产生差异（README 素材 + 回归验证）
 *
 * @module dsh-mylife/lib/compare
 */

import { readProfile, queryClaims, readIndex } from './store.js'
import { checkStaleness } from './fields.js'

/**
 * 采集一次完整状态快照。
 *
 * @param {object} params
 * @param {string} params.stage - 标记，如 'before' | 'after'
 * @param {string} [params.decision] - 决策字段名
 * @param {object} [params.config]
 * @returns {Promise<object>}
 */
export async function snapshotState({ stage, decision = null, config = {} }) {
  const fields = await readProfile({ config })
  const claims = await queryClaims({ status: 'all', config })
  const index = await readIndex({ config })
  const stale = checkStaleness({ fields, decision })

  return {
    stage,
    at: new Date().toISOString(),
    decision,
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [
        k,
        { value: v.value ?? null, source: v.source ?? null, updated_at: v.updated_at ?? null },
      ]),
    ),
    /** 有值的字段名 */
    filled: Object.entries(fields)
      .filter(([, v]) => v.value !== null && v.value !== undefined && v.value !== '')
      .map(([k]) => k),
    /** 声明为依赖但从未填值的字段 */
    unset: (stale.unset ?? []).map((x) => x.field),
    /** 依赖中已过期的字段 */
    staleFields: (stale.blocking ?? []).map((x) => x.field),
    dependencies: stale.checked ?? [],
    claims: claims.length,
    topics: [...new Set(claims.map((c) => c.topic))].sort(),
    conclusions: (index.conclusions ?? []).length,
  }
}

/**
 * 对比两个快照，产出**可检验的差异**。
 *
 * 刻意不产出"结论变好了"这类判断 —— 那是用户的判断，不是系统的。
 * 这里只陈述机械的差异：哪些字段从空变有、依赖覆盖度如何、决策可判定性如何变化。
 *
 * @param {object} before
 * @param {object} after
 * @returns {object}
 */
export function diffSnapshots(before, after) {
  const bFilled = new Set(before.filled ?? [])
  const aFilled = new Set(after.filled ?? [])
  const newlyFilled = [...aFilled].filter((f) => !bFilled.has(f))
  const stillUnset = [...new Set([...(before.unset ?? []), ...(after.unset ?? [])])].filter(
    (f) => !aFilled.has(f),
  )

  const deps = after.dependencies ?? before.dependencies ?? []
  const covered = deps.filter((d) => aFilled.has(d))
  const coverage = deps.length ? covered.length / deps.length : 0

  return {
    newlyFilled,
    stillUnset,
    /** 决策所依赖字段的填充覆盖率 */
    coverage,
    coverageBefore: ratio(
      (before.dependencies ?? []).filter((d) => bFilled.has(d)).length,
      (before.dependencies ?? []).length,
    ),
    /** 决策是否已具备可判定的数据基础 */
    decidable: (after.unset ?? []).length === 0,
    wasDecidable: (before.unset ?? []).length === 0,
    claimsAdded: Math.max(0, (after.claims ?? 0) - (before.claims ?? 0)),
    newTopics: (after.topics ?? []).filter((t) => !(before.topics ?? []).includes(t)),
    conclusionsAdded: Math.max(0, (after.conclusions ?? 0) - (before.conclusions ?? 0)),
  }
}

function ratio(n, d) {
  return d ? n / d : 0
}

/**
 * 渲染对比文案。
 *
 * 措辞要求与产品一致：**陈述事实，把判断交回用户**。
 * 不写"现在结论更可靠了" —— 系统没有资格替用户下这个判断。
 *
 * @param {object} params
 * @param {object} params.before
 * @param {object} params.after
 * @param {object} [params.diff]
 * @returns {string}
 */
export function renderComparison({ before, after, diff }) {
  const d = diff ?? diffSnapshots(before, after)
  const pct = (x) => `${Math.round(x * 100)}%`
  const lines = ['## 补上空白前后：机械差异', '']

  lines.push(
    `决策「${after.decision ?? before.decision ?? '（未指定）'}」所依赖的字段，` +
      `填充覆盖率从 **${pct(d.coverageBefore)}** 变成 **${pct(d.coverage)}**。`,
    '',
  )

  if (d.newlyFilled.length) {
    lines.push('**这次补上的：**')
    for (const f of d.newlyFilled) {
      lines.push(`- ${f}：${format(after.fields?.[f]?.value ?? (before.fields?.[f]?.value ?? '（空）'))}`)
    }
    lines.push('')
  }

  if (d.stillUnset.length) {
    lines.push('**仍然是空白的：**')
    for (const f of d.stillUnset) lines.push(`- ${f}`)
    lines.push(
      '',
      '⚠️ 这些仍然没有依据。**下面的结论里，凡是依赖它们的部分都必须标注不确定性。**',
      '',
    )
  }

  lines.push(
    d.decidable && !d.wasDecidable
      ? '→ 依赖字段已填齐，**这个决定现在具备了数据基础**。'
      : d.decidable
        ? '→ 依赖字段本来就是齐的（本次没有新增可判定性）。'
        : '→ **仍然不可判定**：还有空白没补。',
  )

  if (d.claimsAdded || d.newTopics.length || d.conclusionsAdded) {
    lines.push('')
    const bits = []
    if (d.claimsAdded) bits.push(`新增证据 ${d.claimsAdded} 条`)
    if (d.newTopics.length) bits.push(`新主题：${d.newTopics.join('、')}`)
    if (d.conclusionsAdded) bits.push(`新增结论 ${d.conclusionsAdded} 条`)
    lines.push(`记录本身的变化：${bits.join('；')}。`)
  }

  lines.push(
    '',
    '---',
    '',
    '以上只是**机械差异**。结论是不是更可靠、你该不该改主意 —— **那是你的判断**。' +
      '我能做的是把变动如实摆出来。',
  )
  return lines.join('\n')
}

function format(v) {
  if (v === null || v === undefined || v === '') return '（空）'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
