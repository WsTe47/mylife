/**
 * MyLife · staleness & field-inference layer
 *
 * 这一层回答两个问题：
 *   1. 「回答这个问题，我依赖哪些字段？」—— 决策 → 字段的依赖图
 *   2. 「这些字段里哪些可能已经不准了？」—— 逐字段 TTL 判定
 *
 * 设计决定（对应你的要求"字段词典不预制"）：
 *   依赖关系**由运行时声明**，不预置任何领域词典。
 *   agent 创建决策字段时声明 `depends_on`，时效检查据此递归展开。
 *   这样既保持开放（用户可以聊任何主题），又不丢掉时效能力。
 *
 * 为什么要给"沿用旧值"这个选项：
 *   如果过期就拒绝回答，用户会被卡住并厌烦。
 *   正确做法是提示 + 允许降权沿用，并在输出里强制标注不确定性。
 *
 * @module dsh-mylife/lib/fields
 */

import { NO_EXPIRY } from './store.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * 从字段名推断一个合理的 TTL（天数）。
 *
 * 仅在创建字段时**建议**使用，最终值由用户确认（见 TECH_DESIGN 2.3）。
 * 编排顺序很重要：先匹配更具体的模式，避免"月收入"被"收入"以外的规则抢先。
 *
 * @param {string} name - 字段名
 * @returns {number|null} 天数；null 表示不过期
 */
export function inferTtlDays(name) {
  const n = String(name ?? '')
  if (n === '') return NO_EXPIRY

  // 永不过期的客观事实
  if (/(学历|学位|毕业|专业|籍贯|出生|生日|年龄|工龄|入职时间|身份证)/.test(n)) return NO_EXPIRY
  if (/(价值观|底线|原则|无法接受|偏好)/.test(n)) return NO_EXPIRY

  // 变化很快
  if (/(存款|储蓄|结余|余额|现金|信用卡|负债|欠款|分期|贷款余额)/.test(n)) return 90
  if (/(月收入|月支出|月消费|月供|房租|薪酬|工资|奖金|收入)/.test(n)) return 180
  if (/(体重|健康|睡眠|压力|加班)/.test(n)) return 180

  // 变化较慢
  if (/(职位|岗位|职级|工作年限|房贷|车贷|保险|理财|基金|股票|资产)/.test(n)) return 365
  if (/(职业规划|职业目标|长期目标|期望|计划)/.test(n)) return 365

  // 未知字段：给一个中庸默认值，但标注是猜的
  return 365
}

/**
 * 判断某字段是否过期（或即将过期）。
 *
 * @param {object} field - 字段记录（含 updated_at / ttl_days）
 * @param {Date} [now] - 当前时间
 * @param {number} [warnRatio] - 剩余寿命低于此比例即视为"即将过期"
 * @returns {{state: string, ageDays: number|null, ttlDays: number|null, remainingDays: number|null}}
 *          state ∈ fresh | expiring | stale | no-expiry | unknown
 */
export function fieldFreshness(field, now = new Date(), warnRatio = 0.15) {
  const ttl = field?.ttl_days
  const updatedAt = field?.updated_at
  if (ttl === NO_EXPIRY || ttl === undefined) {
    return { state: 'no-expiry', ageDays: ageInDays(updatedAt, now), ttlDays: null, remainingDays: null }
  }
  const age = ageInDays(updatedAt, now)
  if (age === null) {
    return { state: 'unknown', ageDays: null, ttlDays: ttl, remainingDays: null }
  }
  const remaining = ttl - age
  if (remaining < 0) return { state: 'stale', ageDays: age, ttlDays: ttl, remainingDays: remaining }
  if (remaining <= ttl * warnRatio) {
    return { state: 'expiring', ageDays: age, ttlDays: ttl, remainingDays: remaining }
  }
  return { state: 'fresh', ageDays: age, ttlDays: ttl, remainingDays: remaining }
}

/** 距今天数；无日期返回 null。 */
export function ageInDays(dateStr, now = new Date()) {
  if (!dateStr) return null
  const then = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(then.getTime())) return null
  return Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY)
}

/**
 * 沿依赖图递归展开某决策所依赖的全部字段。
 *
 * 返回按层级排序的字段名列表（去重、含自身）。
 * 遇到环会安全终止。
 *
 * @param {object} fields - 全部字段
 * @param {string} decisionField - 决策字段名
 * @returns {string[]}
 */
export function resolveDependencies(fields, decisionField) {
  const out = []
  const seen = new Set()
  const walk = (name) => {
    if (seen.has(name)) return
    seen.add(name)
    out.push(name)
    const deps = fields?.[name]?.depends_on
    if (Array.isArray(deps)) for (const d of deps) walk(d)
  }
  walk(decisionField)
  return out
}

/**
 * 检查某个决策的阻塞性过时字段。
 *
 * 这是你要的「生成决策时发现依赖的信息过时，首先提醒使用者去确认」。
 *
 * @param {object} params
 * @param {object} params.fields - 全部档案字段
 * @param {string} [params.decision] - 决策字段名；省略则检查全部字段
 * @param {Date} [params.now]
 * @returns {{decision: string|null, blocking: object[], expiring: object[], checked: string[]}}
 */
export function checkStaleness({ fields, decision = null, now = new Date() }) {
  const names = decision ? resolveDependencies(fields, decision) : Object.keys(fields ?? {})
  const blocking = []
  const expiring = []
  for (const name of names) {
    const field = fields?.[name]
    if (!field) continue
    const fresh = fieldFreshness(field, now)
    const row = {
      field: name,
      value: field.value,
      source: field.source ?? 'unknown',
      updated_at: field.updated_at ?? null,
      ageDays: fresh.ageDays,
      ttlDays: fresh.ttlDays,
      state: fresh.state,
      isDecision: name === decision,
    }
    if (fresh.state === 'stale') blocking.push(row)
    else if (fresh.state === 'expiring') expiring.push(row)
  }
  return { decision, blocking, expiring, checked: names }
}

/**
 * 生成给用户看的确认文案。
 *
 * 措辞要求：说清"为什么需要"和"过期会影响什么"，并**必须给出沿用选项**。
 *
 * @param {object} result - checkStaleness 的返回值
 * @param {string} [label] - 决策的可读名称
 */
export function renderStalenessPrompt(result, label) {
  // 防御：输出可能不完整（例如被别的投影裁剪），不能因此抛错
  const blocking = Array.isArray(result?.blocking) ? result.blocking : []
  const expiring = Array.isArray(result?.expiring) ? result.expiring : []
  result = { ...result, blocking, expiring }
  if (!blocking.length && !expiring.length) return null
  const lines = []
  if (blocking.length) {
    lines.push(
      `回答「${label ?? result.decision ?? '这个问题'}」需要以下信息，但它们可能已经不准了：`,
      '',
    )
    for (const row of result.blocking) {
      const age = row.ageDays === null ? '时间未知' : `${row.ageDays} 天前填写`
      const ttl = row.ttlDays === null ? '' : `，有效期 ${row.ttlDays} 天`
      lines.push(`  · ${row.field}：${formatValue(row.value)}（${age}${ttl}）`)
    }
    lines.push(
      '',
      '这些数字会直接影响结论 —— 例如存款变化会改变你承受空窗期的能力。',
      '',
      '  [现在更新] 提供新数值，我会重算',
      '  [沿用旧值] 我会照常回答，但结论会标注"基于可能过时的数据"并降权',
    )
  }
  if (result.expiring.length) {
    lines.push('', '另外，以下信息快到有效期了，方便时确认一下：')
    for (const row of result.expiring) {
      lines.push(`  · ${row.field}（还剩约 ${row.remainingDays ?? '?'} 天）`)
    }
  }
  return lines.join('\n')
}

/** 值的简短呈现。 */
function formatValue(v) {
  if (v === null || v === undefined) return '（空）'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
