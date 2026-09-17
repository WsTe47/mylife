/**
 * MyLife · defeater chain（证伪链）
 *
 * 这是反证引擎的**主路径**，取代原先的词法极性引擎。
 *
 * ## 为什么要换
 *
 * 原引擎用固定词典匹配正负词（"想跳槽" vs "不会离开"）。在真实语料上
 * （12683 字深夜随笔、23 条证据）它返回 **0 findings**。人眼却能看到至少三条张力：
 *
 *   - "一定该离开" ↔ "愧对好领导"    → 不在同一命题上
 *   - "同事都 nice" ↔ "每一天不快乐"  → 对**不同对象**的评价（人 vs 系统）
 *   - "钱不排第一位" ↔ 情绪全在待遇   → 需要跨主题聚合
 *
 * **反证的本质不是"找反义词"，是"找能推翻结论的东西"。**
 *
 * ## 证伪链
 *
 *   主判断 P
 *     → 生成证伪项 D：什么若是真的，P 就该被推翻
 *          · internal：这个人自己文中就有的张力
 *          · gap     ：若成立则 P 被推翻，而判定所需信息**本人能自答但没给**
 *     → 逐条回原文检索
 *     → 三态判定：A 有支持 / B 被否定 / **C 无证据**
 *
 * **第三态是本设计最重要的部分**：C 说明"你的判断建立在一片没有数据的区域上"，
 * 这往往比找到反例更有用。
 *
 * ## 措辞纪律（写进代码，不靠提示词）
 *
 * 真实测试中出现过一次误报：把"我爱财，但在工作上不把钱放第一"这个**自我澄清**
 * 当成了矛盾。在心理场景下，**把澄清误判为矛盾是有害的** ——
 * 用户深夜写这些，不是在等系统指出他逻辑不严谨。
 *
 * 因此渲染层强制：
 *   1. 是提问，不是判定
 *   2. 给出"两句可能同时为真"的解释路径
 *   3. internal 型必须显式标出对立双方，让用户能自行判断是否误解
 *   4. 必须提供"这不是矛盾"的出路，并说明会被记录下来用于校准
 *
 * @module dsh-mylife/lib/defeater
 */

/** 证伪项类型。 */
export const DEFEATER_TYPES = ['internal', 'gap']

/**
 * 判定态。
 *
 * A / B / C 是三态主判定；**R 是 B 的细分**，单独拎出来是因为措辞完全不同：
 *   B 表示"原文的事实否定了这个证伪项"（对外部事实的检索结果）
 *   R 表示"**本人已经想过并主动排除了这一点**"（对自己论证的回顾）
 * 两者都说证伪项不成立，但对用户的意义相反 —— R 尤其值得指出，
 * 因为它说明这个点已经被处理过，不该再被当作疑点抛回去。
 */
export const VERDICTS = {
  A: '支持该证伪项 —— 它削弱主判断',
  B: '原文否定了该证伪项',
  R: '你自己已经想过并排除了这一点',
  C: '原文没有相关证据 —— 这是空白',
}

/**
 * 宽容地从 LLM 回复里取出 JSON。
 *
 * LLM 有时会包 ```json 代码块，或前后带解释文字。这里尽量救回来，
 * 而不是让一次格式抖动毁掉整次分析。
 *
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    try {
      return JSON.parse(c.trim())
    } catch {
      // 退一步：截取第一个 { 到最后一个 }
      const s = c.indexOf('{')
      const e = c.lastIndexOf('}')
      if (s !== -1 && e > s) {
        try {
          return JSON.parse(c.slice(s, e + 1))
        } catch {
          /* 继续 */
        }
      }
    }
  }
  return null
}

/** 规范化一条证伪项；缺字段就丢弃（宁可少，不要脏）。 */
function normalizeDefeater(raw, idx) {
  if (!raw || typeof raw !== 'object') return null
  const proposition = String(raw.proposition ?? '').trim()
  if (proposition === '') return null
  const type = DEFEATER_TYPES.includes(raw.type) ? raw.type : 'gap'
  const label = String(raw.label ?? '').trim()
  return {
    id: `D${idx + 1}`,
    type,
    // 短标题优先；模型没给就用 proposition 截断兜底，保证渲染永远短
    label: label || shorten(proposition, 24),
    proposition,
    why_it_defeats: String(raw.why_it_defeats ?? '').trim() || null,
    evidence_needed: String(raw.evidence_needed ?? '').trim() || null,
    tension_between: String(raw.tension_between ?? '').trim() || null,
  }
}

const GEN_SYSTEM = `给定一个人的自述文本与他要做的主判断 P，生成证伪项（defeaters）。

证伪项的定义：**若它为真，P 就应该被推翻或大幅削弱。**

生成两类，各 3 条：

**类型 internal（内在张力）**：这个人自己在文中已经给出了与 P 有张力的表述。
张力**不一定是反义词**，常见形态：
  - 对**不同对象**的相反评价（例如说"同事都很好"，但不满的是"制度"）
  - **声明 vs 实际情绪**（例如说"钱不重要"，但最激烈的情绪都在待遇上）
  - 承认的小事 vs 强烈的反应
每条必须在 tension_between 里写清**对立的两方分别是什么**。

**类型 gap（空白）**：若成立则 P 被推翻，而判定它所需的信息
**是这个人自己本来就有、但文中没给的**。排除需要外部市场数据或他人配合的。

严格约束：
- 每条必须具体、可检验。禁止"需要更全面地考虑"这类空话。
- 不要为了凑数硬编。宁可少给，也不要编造原文没有的对立。
- 你不需要评判 P 对不对，只负责找"什么能推翻它"。

输出要求：
- **label**：不超过 20 字的短标题，像"领导认可足以留住他"这样的陈述句。
  **不要在 label 或 proposition 里引用原文句子**（原文引用由后续检索步骤负责）。
- **proposition**：一到两句的完整命题，仍然不要贴原文。
- 只输出 JSON：{"defeaters":[{"label":"","proposition":"","type":"internal|gap","why_it_defeats":"","evidence_needed":"","tension_between":""}]}

关于 gap 的严格定义（很重要，别搞错）：
  gap 必须是**能改变这个决定、且本人当下就能给出答案的客观事实**。
  典型：存款能撑几个月、月供多少、市场给到的定价、能否接受降薪。
  **反例（不要生成）**：关于他心理成因的追问（"为何失去热爱""入行前是否也这样"），
  关于童年或传记的问题，以及需要外部调研或他人配合才能回答的问题。
  判断标准：如果一个理性的人要下这个决定，**必须知道这个数**，那才是 gap。`

const SEARCH_SYSTEM = `判断给定的「证伪项」在原文中的证据状况，严格三选一：

  A = 原文**真的支持**这个证伪项（即它确实能削弱主判断）→ 给出逐字引用
  B = 原文用**外部事实**否定了它
  R = **作者本人已经主动提出并排除了这一点**（他自己承认了、并给出了理由）
      例如原文写"我知道领导很好，但这不足以抵消我不开心" ——
      这就是 R：他本人已处理过这个疑点，不该再当疑点抛回给他
  C = 原文**完全没有**相关证据

铁律：
- **禁止用常理、常识或外部知识补充。** 原文没有就是 C。
- quotes 必须是原文里**逐字存在**的片段，不得改写、不得拼接。
- 如果是 internal 型，还要指出原文中对立的具体两句话。
- **证伪项被"自我澄清"否定时必须判 B，不能判 A。**
  例：证伪项说"他对琐事的抱怨权重可能被高估"，
  而原文说"这些都不是什么大事，我心里也很清楚" ——
  这句原文**否定**了该证伪项（他本人已经承认了这一点），所以是 B。
  判 A 只在原文**真的支持**该证伪项（即真的能削弱主判断）时才用。
- 两句话可以同时为真时（例如先承认"我爱财"，再说"但在工作上我不把钱放第一位"），
  那是**自我澄清而非矛盾**，在 note 里点明。
- note 一句话，中性、不评判。

JSON: {"verdict":"A|B|R|C","quotes":["逐字原话"],"contradiction_pair":["句1","句2"]或null,"note":""}`

/**
 * 生成证伪项。
 *
 * @param {object} params
 * @param {string} params.proposition - 主判断 P
 * @param {string} params.corpus - 自述原文
 * @param {Function} params.llm - 注入的 LLM 函数
 * @returns {Promise<object[]>}
 */
export async function generateDefeaters({ proposition, corpus, llm }) {
  if (!proposition) throw new Error('generateDefeaters: 需要 proposition')
  if (!corpus) throw new Error('generateDefeaters: 需要 corpus')

  const text = await llm(
    [
      { role: 'system', content: GEN_SYSTEM },
      { role: 'user', content: `主判断 P：${proposition}\n\n自述原文：\n${corpus}` },
    ],
    { json: true, maxTokens: 2200 },
  )
  const parsed = extractJson(text)
  const list = Array.isArray(parsed?.defeaters) ? parsed.defeaters : []
  return list.map(normalizeDefeater).filter(Boolean)
}

/**
 * 逐条检索证伪项在原文中的证据。
 *
 * @param {object} params
 * @param {object[]} params.defeaters
 * @param {string} params.corpus
 * @param {Function} params.llm
 * @returns {Promise<object[]>} 每条附 verdict / quotes / contradiction_pair / note
 */
export async function searchDefeaters({ defeaters, corpus, llm }) {
  const out = []
  for (const d of defeaters ?? []) {
    let verdict = 'C'
    let quotes = []
    let contradiction_pair = null
    let note = ''
    try {
      const text = await llm(
        [
          { role: 'system', content: SEARCH_SYSTEM },
          {
            role: 'user',
            content:
              `证伪项：${d.proposition}\n类型：${d.type}\n` +
              `判定所需证据：${d.evidence_needed ?? '（未指定）'}\n\n原文：\n${corpus}`,
          },
        ],
        { json: true, maxTokens: 800 },
      )
      const j = extractJson(text) ?? {}
      if (['A', 'B', 'R', 'C'].includes(j.verdict)) verdict = j.verdict
      if (Array.isArray(j.quotes)) quotes = j.quotes.filter((q) => typeof q === 'string')
      if (Array.isArray(j.contradiction_pair) && j.contradiction_pair.length === 2) {
        contradiction_pair = j.contradiction_pair.map(String)
      }
      note = String(j.note ?? '')
    } catch (err) {
      // 单条失败不能毁掉整次分析 —— 标为未判定，让调用方知道
      note = `判定失败：${err?.message ?? err}`
      verdict = '?'
    }
    out.push({ ...d, verdict, quotes, contradiction_pair, note })
  }
  return out
}

/**
 * 组装完整分析。
 *
 * @param {object} params
 * @param {string} params.proposition
 * @param {string} params.corpus
 * @param {Function} params.llm
 * @returns {Promise<{proposition: string, results: object[], summary: object}>}
 */
export async function buildDefeaterAnalysis({ proposition, corpus, llm }) {
  const defeaters = await generateDefeaters({ proposition, corpus, llm })
  const results = await searchDefeaters({ defeaters, corpus, llm })
  const summary = {
    total: results.length,
    weakened: results.filter((r) => r.verdict === 'A').length,
    strengthened: results.filter((r) => r.verdict === 'B').length,
    resolved: results.filter((r) => r.verdict === 'R').length,
    blank: results.filter((r) => r.verdict === 'C').length,
    undecided: results.filter((r) => r.verdict === '?').length,
  }
  return { proposition, results, summary }
}

/** 三态对应的中性标签。 */
const VERDICT_LABEL = {
  A: '⚠️ 原文真的支持它 —— 这条会削弱主判断',
  B: '○ 原文用事实否定了它（对外的检索结果）',
  R: '✓ 你自己已经想过并排除了它 —— 不必再当疑点',
  C: '⬜ 原文没有相关证据 —— 这里是一片空白',
  '?': '（这条未能判定）',
}

/**
 * 渲染成给用户看的文案。
 *
 * **措辞纪律在这里强制**（见文件头注释）。所有内容以提问收尾，
 * 并给出"这不是矛盾"的出路。
 *
 * @param {object} params
 * @param {string} params.proposition
 * @param {object[]} params.results
 * @param {object} [params.summary]
 * @returns {string}
 */
export function renderDefeaterReport({ proposition, results, summary }) {
  const lines = [`## 如果要推翻「${proposition}」，需要看这几件事`, '']
  const s = summary ?? {
    total: results.length,
    weakened: results.filter((r) => r.verdict === 'A').length,
    strengthened: results.filter((r) => r.verdict === 'B').length,
    resolved: results.filter((r) => r.verdict === 'R').length,
    blank: results.filter((r) => r.verdict === 'C').length,
    undecided: results.filter((r) => r.verdict === '?').length,
  }

  lines.push(
    `我找了 ${s.total} 个"若能成立就会推翻它"的点。其中 ` +
      `${s.weakened} 条真的能削弱你的判断，` +
      `${s.resolved ?? 0} 条你自己已经想过并排除了，` +
      `${s.strengthened} 条被原文事实否定，` +
      `**${s.blank} 条完全没有证据**。`,
    '',
    '下面每一条都不是结论，只是**需要你自己判断的地方**。',
    '',
  )

  for (const r of results) {
    lines.push(`### ${r.id}｜${r.label ?? shorten(r.proposition, 24)}`)
    lines.push('')
    lines.push(`类型：${r.type === 'internal' ? '你文中已有的张力' : '记录里的空白'}`)
    lines.push(`判定：${VERDICT_LABEL[r.verdict] ?? r.verdict}`)
    if (r.label && r.label !== r.proposition) {
      lines.push('')
      lines.push(`> ${r.proposition}`)
    }

    if (r.type === 'internal' && r.tension_between) {
      lines.push(`对立的两方：${r.tension_between}`)
    }
    // 对立双方优先展示；已被 contradiction_pair 覆盖的 quote 不重复贴
    const shown = new Set()
    if (r.contradiction_pair) {
      for (const p of r.contradiction_pair) {
        lines.push(`  · ${trim(p, 90)}`)
        shown.add(trim(p, 90).slice(0, 20))
      }
    }
    for (const q of (r.quotes ?? [])) {
      const t = trim(q, 110)
      if ([...shown].some((s0) => t.startsWith(s0.slice(0, 12)))) continue
      if (lines.filter((l) => l === `  > ${t}`).length) continue
      lines.push(`  > ${t}`)
      if (shown.size > 4) break
    }
    if (r.note) {
      lines.push('')
      lines.push(`说明：${r.note}`)
    }

    // 每条都以提问收尾 —— 这是纪律，不是风格。
    //
    // 这里有两个**相互独立**的决定，不要合并成一条 if-else 链：
    //   ① 主收尾由 verdict 决定（R / C / 其它）
    //   ② "可能并不矛盾"这句只与 type=internal 有关，
    //      且对 R 同样适用 —— R 本身就是"它不矛盾"的证据。
    lines.push('')
    if (r.verdict === 'R') {
      lines.push('> 这一点**你已经处理过了** —— 我不再把它当作疑点。' +
        '如果你觉得当时排除得草率，现在可以重新看。')
    } else if (r.verdict === 'C') {
      lines.push(`> **这一点在你的记录里没有依据。** 你愿意补上吗？` +
        `（需要：${r.evidence_needed ?? '相关信息'}）` +
        '如果不补，我不会替你假设一个答案。')
    } else {
      lines.push('> **这一条你怎么看？** 如果它其实不影响你的决定，告诉我，我会记下来。')
    }
    if (r.type === 'internal') {
      lines.push('>')
      lines.push('> 它们可能并不矛盾 —— 也许说的是同一件事的不同侧面。' +
        '如果我说错了，告诉我，我会记下来。')
    }
    lines.push('')
  }

  // 空白汇总 —— 这是本设计最有价值的输出
  const blanks = results.filter((r) => r.verdict === 'C')
  if (blanks.length) {
    lines.push('---', '', '### 最值得注意的：空白', '')
    lines.push(
      `有 ${blanks.length} 个能推翻你判断的点，**在你的记录里找不到任何依据**。`,
      '这不代表它们不成立 —— 只代表**这个决定目前是建立在这些空白之上的**。',
      '',
    )
    for (const b of blanks) lines.push(`- **${b.label ?? shorten(b.proposition, 24)}**${b.evidence_needed ? ` —— 需要：${b.evidence_needed}` : ''}`)
    lines.push('')
  }

  lines.push(
    '---',
    '',
    '以上都不是结论。**把综合判断交回你自己** —— 我能做的只是把该看的地方摆出来。',
  )
  return lines.join('\n')
}

/** 短标题兜底：把长命题压成可读标题。 */
function shorten(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const cut = t.slice(0, n)
  // 尽量在标点处断开
  const m = /^(.*?)[，。；：,;]/.exec(cut)
  return (m ? m[1] : cut) + '…'
}

/** 单行截断，避免渲染出巨块。 */
function trim(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}
