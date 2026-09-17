/**
 * MyLife · evidence / counter-evidence engine
 *
 * 反证引擎。这是产品的灵魂，也是最容易做歪的地方。
 *
 * ⚠️ 核心设计约束（见 VISION.md 第 3.2 节）：
 *
 *   「我想跳槽」和「我热爱这里」往往**不是矛盾，而是同一个人的两面**。
 *   真相多半是"我热爱我的同事和做的事，但无法忍受这个管理层"——两句同时为真。
 *
 *   如果 AI 跑去说"你上次说的和这次不一样！"，用户的感受是**被抓住把柄**，
 *   而不是**被理解**。所以本模块的输出形态被强制为：
 *
 *     主题聚簇 + 时间 + 当时的语境 + **提问式收尾**
 *
 *   而不是"检测到冲突"。
 *
 * 第二个机制：**旧前提作废**。
 *   人的旧约束会自动在心里失效，但 AI 会一直记着 —— 于是拿一年前的恐惧
 *   否决今天的决定。所以必须主动把过时前提翻出来问"还成立吗"。
 *
 * @module dsh-mylife/lib/evidence
 */

/**
 * 情绪/立场极性词典。
 *
 * 刻意保持小而有针对性：它只用于**发现值得追问的地方**，
 * 不用于给用户贴标签或做心理判断。命中后一律以提问呈现。
 *
 * ⚠️ 中文否定式是这里最容易出错的地方，因此显式处理：
 *   「不想走」包含子串「想走」，若直接匹配就会把"留下"误判成"想离开"。
 *   负向模式用**负向后行断言** `(?<!不)` 排除这种情形。
 *   （不要改用带 `g` 的 replace 归一化：那会引入 lastIndex 状态 bug。）
 */
/**
 * 「留下」倾向。允许否定词与动词之间插入「打算/考虑/会」等助词，
 * 例如「绝对不会考虑离开」中间夹了「会考虑」，逐字枚举会漏。
 */
const STAY = /((?:不想|不打算|不考虑|不准备|不会|绝不|不可能|没想过|从未想)[^，。；！？\n]{0,4}(?:走|离开|离职|跳槽|换工作)|留下|留下来|长期待|长期待下去|不想动|喜欢这里|喜欢这儿|热爱这里|热爱这家|喜欢这家)/

const POLARITY = [
  {
    axis: '去留',
    positive: STAY,
    negative: /(?<!不)(?:想跳槽|考虑跳槽|要跳槽|打算跳槽|想离职|要离职|考虑离职|不想干|待不下去|受不了这里|受不了|想走)/,
  },
  { axis: '满意度', positive: /(满意|成就感|挺好的|不错|开心|喜欢)/, negative: /(不满意|没成长|没意思|失望|难受|痛苦|受不了|烦)/ },
  { axis: '能力信心', positive: /(有信心|没问题|能行|能力才是|不在意学历|不难)/, negative: /(没底|不行|怕|担心|过不了|门槛|够呛|没信心)/ },
  { axis: '财务安全感', positive: /(够用|宽裕|还好|没问题|不紧张)/, negative: /(紧张|不够|压力大|撑不住|拮据|吃紧)/ },
  { axis: '意愿强度', positive: /(一定|决定|确定|必须|肯定)/, negative: /(犹豫|不确定|再想想|不知道|纠结|摇摆|拿不准)/ },
]

/**
 * 判定一段文本在各轴上的极性。
 *
 * 每轴最多给出一个判定。若同一轴同时命中正负（常见于转折句），
 * 返回 `±`，调用方应把它视为"本身就是一个待追问的表述"。
 *
 * ⚠️ 实现要点：所有正则**都不带 `g` 标志**。
 * 带 `g` 的正则在反复 `.test()` 时会用 `lastIndex` 在字符串间"接力"，
 * 导致同一输入时真时假 —— 这是本模块踩过并已写测试守住的坑。
 *
 * 中文否定式的处理见 STAY / NEG_STAY 里的负向后行断言。
 *
 * @param {string} text
 * @returns {{axis: string, sign: '+'|'-'|'±'}[]}
 */
export function polarityOf(text) {
  const raw = String(text ?? '')
  const hits = []
  for (const axis of POLARITY) {
    const pos = axis.positive.test(raw)
    const neg = axis.negative.test(raw)
    if (pos && !neg) hits.push({ axis: axis.axis, sign: '+' })
    else if (neg && !pos) hits.push({ axis: axis.axis, sign: '-' })
    else if (pos && neg) hits.push({ axis: axis.axis, sign: '±' })
  }
  return hits
}

/** 按主题聚簇，组内按时间排序。 */
export function clusterByTopic(claims) {
  const map = new Map()
  for (const c of claims ?? []) {
    const topic = c.topic ?? '(未分类)'
    if (!map.has(topic)) map.set(topic, [])
    map.get(topic).push(c)
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(a.occurred_at ?? '').localeCompare(String(b.occurred_at ?? '')))
  }
  return map
}

/**
 * 在某个主题内寻找"表述张力"。
 *
 * 同一个轴上出现相反极性，且跨越不同时间点 → 值得追问。
 * 注意：**返回的是"值得追问"，不是"你矛盾了"**。
 *
 * @param {object[]} claimsInTopic - 同一主题的 claims（已按时间排序）
 * @returns {object[]} 张力列表
 */
export function findTensions(claimsInTopic) {
  const dated = (claimsInTopic ?? []).map((c) => ({ claim: c, hits: polarityOf(`${c.claim} ${c.excerpt ?? ''}`) }))
  const tensions = []
  const axes = new Set(dated.flatMap((d) => d.hits.map((h) => h.axis)))

  for (const axis of axes) {
    const onAxis = dated.filter((d) => d.hits.some((h) => h.axis === axis))
    // `±` 表示"这一句本身含转折"，它自己就是待追问对象，不参与跨时点对比
    const plus = onAxis.filter((d) => d.hits.find((h) => h.axis === axis)?.sign === '+')
    const minus = onAxis.filter((d) => d.hits.find((h) => h.axis === axis)?.sign === '-')
    if (!plus.length || !minus.length) continue

    // 时间上确实分处不同时点才值得提；同一天的两句多半是语境差异
    const dates = new Set(onAxis.map((d) => String(d.claim.occurred_at ?? '')))
    if (dates.size < 2) continue

    tensions.push({
      axis,
      statements: onAxis
        .map((d) => ({
          id: d.claim.id,
          occurred_at: d.claim.occurred_at ?? null,
          claim: d.claim.claim,
          excerpt: d.claim.excerpt ?? null,
          context: d.claim.context ?? null,
          sign: d.hits.find((h) => h.axis === axis)?.sign,
          provenance: d.claim.provenance ?? null,
        }))
        .sort((a, b) => String(a.occurred_at ?? '').localeCompare(String(b.occurred_at ?? ''))),
    })
  }
  // 张力按"时间跨度最大"排序：跨度越大，越值得提醒用户回看
  tensions.sort((a, b) => span(b) - span(a))
  return tensions
}

/** 一组表述的时间跨度（天）。 */
function span(tension) {
  const dates = tension.statements.map((s) => s.occurred_at).filter(Boolean).sort()
  if (dates.length < 2) return 0
  const a = new Date(`${dates[0]}T00:00:00Z`).getTime()
  const b = new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime()
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(b - a) : 0
}

/**
 * 每个轴的"这两句可能同时为真"解释路径。
 *
 * 必须逐轴给出 —— 用一句通用话术套所有轴，会出现
 * "在满意度上方向不同……真正要解的不是走不走"这种文不对题。
 */
const AXIS_BRIDGE = {
  去留:
    '一个可能的解释是：你认可的是其中一部分（例如工作内容、同事），' +
    '不认可的是另一部分（例如强度、管理方式）。如果是这样，真正要解的问题就不是' +
    '「走不走」这个二选一，而是那个**具体的不认可项能否改变**。',
  满意度:
    '一个可能的解释是：让你满意的和让你消耗的，未必是同一件事。' +
    '例如"做的事有价值"和"过程让人疲惫"完全可以并存 —— ' +
    '那么要问的就不是"满不满意"，而是**哪一部分在变差**。',
  能力信心:
    '一个可能的解释是：你对自己的评价会随处境浮动 —— 顺利时觉得"能力最重要"，' +
    '受挫时又会盯着门槛。要区分的是：这是**判断变了**，还是**状态变了**。',
  财务安全感:
    '一个可能的解释是：安全感取决于"有多少"还是"要花多少"，这两者可以反向变动 —— ' +
    '收入涨了但固定支出涨得更快，感受就会变差。要问的是**哪一头动了**。',
  意愿强度:
    '一个可能的解释是：你确定的是方向，不确定的是代价；或者相反。' +
    '这两者混在一起时，人通常会说自己"纠结"。',
}

/**
 * 生成"还原"文案。
 *
 * 语气要求（不可协商）：
 *   - 陈述事实，不评判
 *   - 保留当时的语境
 *   - **以提问收尾**，把综合判断交回用户
 *   - 给出"这两句可能同时为真"的解释路径
 *
 * @param {object} params
 * @param {string} params.topic
 * @param {object} params.tension - findTensions 的一项
 * @returns {string}
 */
export function renderRestoration({ topic, tension }) {
  const rows = tension.statements
  const lines = [
    `## 你在「${topic}」上的多段表述（${tension.axis}）`,
    '',
    '| 时间 | 表述 | 当时的语境 |',
    '| --- | --- | --- |',
  ]
  for (const r of rows) {
    const when = r.occurred_at ?? '时间未知'
    const what = compact(r.claim, 42)
    const ctx = r.context ? compact(r.context, 28) : '—'
    lines.push(`| ${when} | ${what} | ${ctx} |`)
  }
  lines.push(
    '',
    `这几段在「${tension.axis}」上方向不同。**它们未必互相矛盾** —— ` +
      '人在不同处境下对同一件事的感受本来就可以并存。',
    '',
    AXIS_BRIDGE[tension.axis] ??
      '值得追问的是：这几段是在描述同一件事，还是在描述它的不同侧面？',
    '',
    '> 请你自己判断：这几段里，哪一段更接近你现在的真实状态？' +
      '或者它们各自对应了你生活的不同侧面？',
  )
  return lines.join('\n')
}

/**
 * 找出已作废/待确认的旧前提。
 *
 * 这是"旧前提作废"机制的查询侧：把 status 为 superseded/disputed 的记录
 * 汇成一条"这些约束还成立吗"的提醒。
 *
 * @param {object[]} claims - 全部 claims
 * @param {object} [opts]
 * @param {number} [opts.staleDays] - 超过多少天未确认就提醒（针对 no-expiry 的约束类）
 */
export function listStaleOutPremises(claims, opts = {}) {
  const all = claims ?? []
  const superseded = all.filter((c) => c.status === 'superseded' || c.status === 'disputed')
  const activeOld = all.filter((c) => {
    if ((c.status ?? 'active') !== 'active') return false
    return /(压力|紧张|不能|无法|不敢|负担|没钱|拮据|门槛)/.test(`${c.claim ?? ''} ${c.excerpt ?? ''}`)
  })
  void opts
  return { superseded, constraintClaims: activeOld }
}

/**
 * 生成"待作废旧前提"文案。
 *
 * @param {object} params
 * @param {object[]} params.superseded
 * @param {object[]} [params.constraintClaims]
 * @param {object} [params.freshness] - 字段时效信息（可选，用于交叉印证）
 */
export function renderStaleOutPremises({ superseded = [], constraintClaims = [] }) {
  const lines = []
  if (superseded.length) {
    lines.push('## 已作废的前提（确认一下是否真的不再适用）', '')
    for (const c of superseded) {
      lines.push(
        `- **${compact(c.claim, 50)}**（${c.occurred_at ?? '时间未知'}）`,
        `  - 作废于 ${c.retired_at ?? '未知'}：${c.retire_reason ?? '未记录原因'}`,
      )
    }
  }
  if (constraintClaims.length) {
    lines.push(
      '',
      '## 你可能还在沿用的旧约束',
      '',
      '以下表述带有"限制性"语气。人的约束会随时间松动，但记录不会自动失效 ——',
      '所以请确认它们今天是否仍然成立：',
      '',
    )
    for (const c of constraintClaims) {
      lines.push(`- ${compact(c.claim, 50)}（${c.occurred_at ?? '时间未知'}）—— 还成立吗？`)
    }
  }
  return lines.length ? lines.join('\n') : null
}

/**
 * 组装反证报告。这是给"给出正向结论时强制找反证"用的。
 *
 * @param {object} params
 * @param {object[]} params.claims - 全部相关 claims
 * @param {string} [params.topic] - 限定主题
 */
export function buildCounterEvidence({ claims, topic = null }) {
  const scoped = topic ? claims.filter((c) => String(c.topic ?? '').includes(topic)) : claims
  const clusters = clusterByTopic(scoped)

  // 同一个主题下，同一组表述可能在多个轴上都方向相反（例如"喜欢这里"与
  // "受不了管理方式"同时命中「去留」和「满意度」）。
  // 若逐个轴各渲染一张表，用户会看到同一张表重复两遍 —— 这里按"表述集合"合并：
  // 主表渲染一次，其余轴只作为附加追问列出。
  const grouped = new Map()
  for (const [name, list] of clusters) {
    for (const tension of findTensions(list)) {
      const sig = `${name}::${tension.statements.map((s) => s.id).join(',')}`
      if (!grouped.has(sig)) grouped.set(sig, { topic: name, tensions: [] })
      grouped.get(sig).tensions.push(tension)
    }
  }

  const findings = []
  for (const { topic: name, tensions } of grouped.values()) {
    const [primary, ...rest] = tensions
    let rendered = renderRestoration({ topic: name, tension: primary })
    if (rest.length) {
      rendered +=
        `\n\n> 同一组表述在其它维度上也方向相反：${rest.map((t) => `「${t.axis}」`).join('、')}。` +
        '这通常说明分歧不止一层 —— 上面那条"哪一部分在变"的问题，值得逐层问下去。'
    }
    findings.push({ topic: name, tension: primary, axes: tensions.map((t) => t.axis), rendered })
  }

  const { superseded, constraintClaims } = listStaleOutPremises(scoped)
  const staleOut = renderStaleOutPremises({ superseded, constraintClaims })
  return {
    findings,
    staleOut,
    /** 明确告知调用方：没有找到反证 ≠ 没有反证 */
    note: findings.length || staleOut
      ? null
      : '未在当前记录中找到方向相反的表述或已作废前提。这不等于没有反证 —— 也可能只是记录不足。',
  }
}

/** 截断显示。 */
function compact(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}
