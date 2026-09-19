/**
 * MyLife · 决策报告装配
 *
 * 把散在各处的产物装成一份完整报告：档案时效 + 证伪链 + 证据表 + 行动 + 改判条件。
 *
 * 设计要点：
 *   1. **可判定性由数据决定，不由情绪决定。** 依赖字段有空白时，
 *      报告必须显式声明"目前不可判定"，而不是硬给一个结论。
 *   2. **每条判断都要能落链。** 证据表里凡是引用用户表述的，都必须带 provenance。
 *   3. 行动项必须含**产物与验收信号**，不接受"努力提升"这类话。
 *
 * @module dsh-mylife/lib/report
 */

import { queryClaims, readProfile, readIndex, traceClaim } from './store.js'
import { checkStaleness, renderStalenessPrompt } from './fields.js'
import { buildDefeaterAnalysis, renderDefeaterReport } from './defeater.js'

/**
 * 决定这次判断能不能下。
 *
 * 规则很硬：**依赖字段有未填的，就不能下结论。**
 * 这不是形式主义 —— 它是"你握的是理由还是依据"这条区别的代码化。
 *
 * @param {object} params
 * @param {object} params.staleness - checkStaleness 的返回
 * @param {object} [params.defeaters] - buildDefeaterAnalysis 的返回
 * @returns {{decidable: boolean, reasons: string[]}}
 */
export function assessDecidability({ staleness, defeaters = null }) {
  const reasons = []
  const unset = staleness?.unset ?? []
  if (unset.length) {
    reasons.push(`决策依赖的 ${unset.length} 个字段从未填过：${unset.map((u) => u.field).join('、')}`)
  }
  if (defeaters) {
    const blank = (defeaters.results ?? []).filter((r) => r.verdict === 'C')
    if (blank.length) {
      reasons.push(`证伪链指出 ${blank.length} 处空白：${blank.map((b) => b.label).join('、')}`)
    }
  }
  return { decidable: reasons.length === 0, reasons }
}

/**
 * 装配完整报告。
 *
 * @param {object} params
 * @param {string} params.proposition - 主判断（用用户的说法）
 * @param {string} params.corpus - 自述原文
 * @param {string} [params.decisionField] - 决策字段名（默认用 proposition）
 * @param {Function} [params.llm] - 注入的 LLM；省略则用真实 API
 * @param {boolean} [params.skipDefeaters] - 跳过证伪链（离线/无凭据时）
 * @param {object} [params.config]
 * @returns {Promise<object>}
 */
export async function assembleReport({
  proposition,
  corpus,
  decisionField = null,
  llm = null,
  skipDefeaters = false,
  config = {},
}) {
  const field = decisionField ?? proposition
  const fields = await readProfile({ config })
  const claims = await queryClaims({ status: 'active', config })
  const index = await readIndex({ config })
  const staleness = checkStaleness({ fields, decision: field })

  let defeaters = null
  let defeaterError = null
  if (!skipDefeaters) {
    try {
      const useLlm = llm ?? (await (await import('./llm.js')).createLlm(config))
      defeaters = await buildDefeaterAnalysis({ proposition, corpus, facts: fields, llm: useLlm })
    } catch (err) {
      // 证伪链跑不了不能毁掉整份报告；但要如实标注
      defeaterError = err?.message ?? String(err)
    }
  }

  const decidability = assessDecidability({ staleness, defeaters })
  const unsourced = claims.filter((c) => !c.provenance)

  return {
    proposition,
    decisionField: field,
    staleness,
    stalenessPrompt: renderStalenessPrompt(staleness, field),
    defeaters,
    defeaterError,
    decidability,
    claims,
    unsourcedClaims: unsourced.map((c) => c.id),
    conclusions: index.conclusions ?? [],
  }
}

/**
 * 渲染成 Markdown 报告。
 *
 * 固定形状，**不可省略任何一段** —— 少一段就等于悄悄把一个反方渠道关掉了。
 *
 * @param {object} r - assembleReport 的返回
 * @param {object} [opts]
 * @param {string} [opts.source] - 原文来源说明
 * @param {string[][]} [opts.actions] - [行动, 产物, 验收信号]
 * @param {string[]} [opts.ifWrong] - "如果你错了" 的条目
 * @param {string[][]} [opts.changeSignals] - [信号, 说明]
 * @returns {string}
 */
export function renderReport(r, opts = {}) {
  const out = []
  out.push(`# MyLife 决策报告 · ${r.proposition}`, '')
  if (opts.source) out.push(`**来源**：${opts.source}`, '')
  const depCount = r.staleness?.checked?.length ?? 0
  const unsetCount = r.staleness?.unset?.length ?? 0
  out.push(
    `**证据**：${r.claims.length} 条（无出处 ${r.unsourcedClaims.length} 条）｜` +
      `**被依赖字段**：${depCount} 个（其中 ${unsetCount} 个从未填写）`,
    '',
  )

  // ── 一、可判定性（必须在最前面）──
  out.push('## 一、这个判断现在能不能下', '')
  if (r.decidability.decidable) {
    out.push('依赖字段已填齐，**具备下判断的数据基础**。', '')
  } else {
    out.push('**目前不可判定。** 原因：', '')
    for (const reason of r.decidability.reasons) out.push(`- ${reason}`)
    out.push(
      '',
      '这不代表你不能做决定 —— 只代表**现在做的决定，依据不完整**。',
      '下面所有结论都建立在这个前提上。',
      '',
    )
  }

  // ── 二、证伪链（放在结论之前）──
  out.push('## 二、什么能推翻这个判断', '')
  if (r.defeaters) {
    out.push(renderDefeaterReport(r.defeaters), '')
  } else if (r.defeaterError) {
    out.push(
      `⚠️ 证伪链未能运行：${r.defeaterError}`,
      '',
      '**在它跑起来之前，任何正向结论都缺少反方检验。** 这是重要的缺失，不是可以忽略的细节。',
      '',
    )
  } else {
    out.push('（本次跳过了证伪链 —— 结论缺少反方检验。）', '')
  }

  // ── 三、信息状态 ──
  out.push('## 三、信息状态', '')
  if (r.stalenessPrompt) {
    out.push(r.stalenessPrompt, '')
  } else {
    out.push('所有被依赖的字段都在有效期内。', '')
  }

  // ── 四、证据 ──
  out.push('## 四、证据', '')
  if (r.unsourcedClaims.length) {
    out.push(
      `⚠️ 有 ${r.unsourcedClaims.length} 条证据没有出处（${r.unsourcedClaims.join('、')}）——`,
      '**它们不得被当作已确认的事实使用。**',
      '',
    )
  }
  if (opts.evidenceTable) {
    out.push(opts.evidenceTable, '')
  } else {
    out.push(`（共 ${r.claims.length} 条有效证据，逐条见 claims/ 目录。）`, '')
  }

  // ── 五、行动 ──
  out.push('## 五、行动', '')
  if (opts.actions?.length) {
    out.push('| # | 行动 | 产物 | 验收信号 |', '|---|---|---|---|')
    opts.actions.forEach(([a, p, v], i) => out.push(`| ${i + 1} | ${a} | ${p} | ${v} |`))
    out.push('')
  } else {
    out.push('（未提供行动项。）', '')
  }

  // ── 六、如果你错了 ──
  out.push('## 六、如果你错了', '')
  if (opts.ifWrong?.length) {
    for (const x of opts.ifWrong) out.push(`- ${x}`)
    out.push('')
  } else {
    out.push('（未提供。）', '')
  }

  // ── 七、改判条件 ──
  out.push('## 七、什么信号出现就该改主意', '')
  if (opts.changeSignals?.length) {
    out.push('| 信号 | 说明 |', '|---|---|')
    for (const [s, d] of opts.changeSignals) out.push(`| ${s} | ${d} |`)
    out.push('')
  } else {
    out.push('（未提供。）', '')
  }

  // ── 八、免责 ──
  out.push(
    '## 免责',
    '',
    '本报告是决策支持与自我认知工具的输出，**仅供参考**，',
    '不构成投资、法律、税务、医疗或心理健康建议。',
    '文中标注为"推断"的部分不是你的原话，你可以否决。',
    '',
  )
  return out.join('\n')
}

/**
 * 溯源抽查：报告里引用的证据能不能回到原文。
 *
 * 这是"锚定证据"承诺的**可检验形式** —— 抽查失败率高，说明报告不可信。
 *
 * @param {object} params
 * @param {string[]} params.ids
 * @param {object} [params.config]
 * @returns {Promise<{checked: number, traced: number, failed: string[]}>}
 */
export async function verifyTraceability({ ids, config = {} }) {
  let traced = 0
  const failed = []
  for (const id of ids ?? []) {
    try {
      const t = await traceClaim({ id, config })
      if (t.traced) traced += 1
      else failed.push(id)
    } catch {
      failed.push(id)
    }
  }
  return { checked: (ids ?? []).length, traced, failed }
}
