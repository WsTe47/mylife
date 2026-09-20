/**
 * MyLife · pending（未填字段的取用与提问）
 *
 * 这一层补的是**闭环的入口**：
 *   「空白 → 提问 → 填档 → 重算」四步里，前三步
 *   （取空白、生成问句、记录回答）过去**没有工具支撑** ——
 *   全靠人工跑脚本。这意味着 agent 从来没有真正走过一次闭环。
 *
 * 设计原则（与本项目其他部分一致）：
 *   1. **空白不是"没问题"，它就是问题。** 未被填写的字段必须主动浮出来。
 *   2. **必须给"跳过"的出路。** 否则用户会被卡住 —— 他要的不是被审问。
 *   3. **绝不替用户假设数值。** 空白只能由他本人填；跳过就如实标注"无依据"。
 *
 * @module dsh-mylife/lib/pending
 */

import { isEmptyValue } from './fields.js'

/**
 * 常见字段的提问模板。
 *
 * 优先用模板而不是每次调 LLM：措辞稳定、零成本、可离线。
 * 只有模板匹配不到时才回退到 LLM（见 {@link draftQuestion}）。
 *
 * `hint` 是给用户的示例，必须给 —— 用户常常不知道怎么答才算"够用"。
 */
const TEMPLATES = [
  { re: /存款|储蓄|结余|余额|现金|资产/, q: (f) => `你的「${f}」大概是多少？`, hint: '给个数量级就够，比如"10–15 万"' },
  { re: /收入|工资|薪酬|月入/, q: (f) => `你的「${f}」大概是多少？`, hint: '比如"税后 1.8 万"' },
  { re: /支出|花费|开销|月供|房租|贷款还款|分期/, q: (f) => `你的「${f}」大概是多少？`, hint: '比如"8000 左右，其中房租 4500"' },
  { re: /负债|欠款|贷|贷款余额/, q: (f) => `你的「${f}」还有多少？`, hint: '比如"还有 2 万分期没还完"' },
  { re: /机会|offer|投递|面试|外部/, q: (f) => `关于「${f}」，你现在手上是什么状况？`, hint: '比如"还没开始投" / "面了两家都没过"' },
  { re: /接受度|接受|底线|容忍|愿意/, q: (f) => `「${f}」上你的底线在哪里？`, hint: '比如"降薪不接受，但换组可以"' },
  { re: /年龄|岁数/, q: (f) => `你的「${f}」是？`, hint: '直接给数字即可' },
  { re: /满意度|感受|状态/, q: (f) => `关于「${f}」，你自己的感受是什么？`, hint: '一两句话，不用组织得很完整' },
]

const FALLBACK_Q = (f) => `「${f}」这一项目前在你的记录里没有依据。你愿意补上吗？`
const FALLBACK_HINT = '一两句话或一个数字都行；说不清就说不清'

/**
 * 为某字段生成问句（模板优先）。
 *
 * @param {string} field
 * @param {object} [opts]
 * @param {string} [opts.note] - 该字段的 provenance / 备注（说明为什么需要它）
 * @returns {{field: string, question: string, hint: string, why: string|null}}
 */
export function draftQuestion(field, opts = {}) {
  for (const t of TEMPLATES) {
    if (t.re.test(field)) {
      return { field, question: t.q(field), hint: t.hint, why: opts.note ?? null }
    }
  }
  return { field, question: FALLBACK_Q(field), hint: FALLBACK_HINT, why: opts.note ?? null }
}

/**
 * 取全部未填字段。
 *
 * **全档案范围扫描**，不限于某个决策声明的依赖 ——
 * 因为用户登记的字段可能还没接进依赖链，那些同样是空白。
 *
 * @param {object} fields - readProfile 的返回
 * @returns {object[]} 每条含 field / value / depends_on / note
 */
export function unsetFields(fields) {
  const out = []
  for (const [field, rec] of Object.entries(fields ?? {})) {
    if (!isEmptyValue(rec?.value)) continue
    out.push({
      field,
      value: rec?.value ?? null,
      note: rec?.provenance ?? null,
      updated_at: rec?.updated_at ?? null,
    })
  }
  return out
}

/**
 * 一次调用拿全部待办：全档案空白 + 逐个决策的卡点 + 现成问句。
 *
 * @param {object} params
 * @param {object} params.fields - readProfile 的返回
 * @param {object} params.staleness - checkStaleness 的返回（decision 省略时是全字段）
 * @param {object[]} [params.decisions] - buildStatus 里那种逐个决策的结果
 * @returns {{unset: object[], blockedDecisions: object[], questions: object[], total: number}}
 */
export function pendingItems({ fields, staleness = null, decisions = [] }) {
  const unset = unsetFields(fields)

  const blocked = (decisions ?? []).filter((d) => !d.decidable)

  // 问句：先给「卡住决策」用的那些（优先级高），再给零散空白
  const seen = new Set()
  const questions = []
  for (const d of blocked) {
    for (const f of d.unset ?? []) {
      if (seen.has(f)) continue
      seen.add(f)
      questions.push({ ...draftQuestion(f, { note: whyNeeded(f, d) }), forDecision: d.field })
    }
  }
  for (const u of unset) {
    if (seen.has(u.field)) continue
    seen.add(u.field)
    questions.push({ ...draftQuestion(u.field, { note: u.note }), forDecision: null })
  }

  // 过期字段也要问，但问题不同（确认是否仍准确，而非首次填写）
  for (const s of staleness?.blocking ?? []) {
    if (seen.has(s.field)) continue
    seen.add(s.field)
    questions.push({
      ...draftQuestion(s.field, {
        note: `${s.ageDays ?? '?'} 天前填写，有效期 ${s.ttlDays ?? '?'} 天`,
      }),
      stale: true,
      forDecision: staleness?.decision ?? null,
    })
  }

  return {
    unset,
    blockedDecisions: blocked.map((d) => ({
      field: d.field,
      value: d.value ?? null,
      missing: d.unset ?? [],
      stale: d.stale ?? [],
    })),
    questions,
    total: unset.length + (staleness?.blocking?.length ?? 0),
  }
}

/** 说明为什么这个字段被需要（用于问句的 why）。 */
function whyNeeded(field, decision) {
  return `「${decision.field}」依赖它 —— 没有它，这个决定无法判定`
}

/**
 * 解析用户的回答。
 *
 * 目标不是"智能抽取"，而是**如实**：
 *   - 用户说跳过 → 记为 skipped（不得编造数值）
 *   - 用户给了内容 → 原样存，但标明来源是用户回答
 *   - 用户没答或答非所问 → 不猜，标记 unclear 让上层再问
 *
 * @param {string} raw - 用户原话
 * @returns {{status: 'answered'|'skipped'|'unclear', value: string|null, note: string|null}}
 */
export function interpretAnswer(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { status: 'unclear', value: null, note: '没有回答内容' }

  // 跳过：必须如实，不得当成数值
  if (/^(跳过|先跳过|跳过这项|不填|先不填|不想说|不方便说|以后再说|略)/.test(text) ||
      /^(skip|pass)$/i.test(text)) {
    return { status: 'skipped', value: null, note: '用户选择不填 —— 结论中必须标注该项无依据' }
  }

  // 明确表示不确定：不算答了，但也不是跳过
  if (/^(不知道|不清楚|没算过|记不清|说不清|不确定)/.test(text) &&
      text.length <= 12) {
    return { status: 'unclear', value: null, note: '用户表示不清楚 —— 不要替他估算' }
  }

  return { status: 'answered', value: text, note: null }
}

/**
 * 把一串问答整理成可写入档案的字段更新。
 *
 * @param {object[]} answers - [{ field, raw }]
 * @returns {{updates: object[], skipped: string[], unclear: string[]}}
 */
export function planProfileUpdates(answers = []) {
  const updates = []
  const skipped = []
  const unclear = []
  for (const a of answers) {
    const parsed = interpretAnswer(a.raw)
    if (parsed.status === 'answered') {
      updates.push({ field: a.field, value: parsed.value, raw: String(a.raw).trim() })
    } else if (parsed.status === 'skipped') {
      skipped.push(a.field)
    } else {
      unclear.push(a.field)
    }
  }
  return { updates, skipped, unclear }
}
