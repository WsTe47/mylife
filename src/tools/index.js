/**
 * MyLife · tool definitions
 *
 * 面向模型的工具。刻意收窄到 10 个 —— 工具越多，模型越不会用。
 *
 * 设计约束（贯穿全部工具）：
 *   1. 每个工具都要**逼出依据**。add_claim 强制 provenance；
 *      trace 让"引不出出处"变成可检测的事实而不是模型的自述。
 *   2. 凡是可能过时的事实，都要求 source 与 updated_at。
 *   3. 反证工具的输出形态是**提问**，不是判定（见 evidence.js）。
 *
 * 用原始 JSON Schema 注册（而非 defineTool），原因：插件不解析 DSH 内部包，
 * 而 ctx.tools.register 本就接受 MCP 风格的原始 JSON Schema。
 *
 * @module dsh-mylife/tools
 */

import {
  addClaim,
  addConclusion,
  queryClaims,
  readDigest,
  readIndex,
  readProfile,
  recordRaw,
  resolveRoot,
  setProfileField,
  supersedeClaim,
  traceClaim,
  writeDigest,
} from '../lib/store.js'
import { checkStaleness, inferTtlDays, renderStalenessPrompt } from '../lib/fields.js'
import { buildCounterEvidence } from '../lib/evidence.js'

/** 把对象渲染成文本内容块。 */
function text(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text: body }]
}

/**
 * 归一化为内容块数组。
 *
 * 各工具的 render 可以直白地返回字符串，也可以返回内容块数组；
 * 这里统一收口，避免每个工具重复包装，也避免漏包导致 render 返回非法类型。
 */
function normalize(content) {
  if (Array.isArray(content)) return content
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  return [{ type: 'text', text }]
}

/** 统一的工具外壳构造。 */
function tool({ name, description, properties, required = [], render }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => normalize(render(value, args)),
    },
  }
}

/**
 * 构造全部工具定义。
 *
 * @param {object} config - 插件配置（含 workspaceRoot）
 * @returns {object[]} 可直接交给 ctx.tools.register 的定义
 */
export function createTools(config = {}) {
  const cfg = { config }

  return [
    // ── 1. 记录原始输入 ────────────────────────────────────────
    tool({
      name: 'mylife_record',
      description:
        '把一段原始输入存入 L0 原始层（永不修改）。用于用户的自述、碎碎念、语音转写、粘贴的文档。' +
        '允许包含错别字、语病与重复 —— 不要替用户"整理"后再存，原文才是证据。\n\n' +
        '返回值里的 `provenance` 是**可以直接拿去用的指针**，请原样引用；' +
        '`startLine`/`endLine` 是正文的精确行区间。' +
        '⚠️ 不要自己猜行号 —— 文件开头有元信息头，猜错会让溯源指向空行，' +
        '而"每条判断可溯源"是 MyLife 的核心承诺。',
      properties: {
        text: { type: 'string', description: '原始文本，逐字保留' },
        topic: { type: 'string', description: '主题标签，仅用于文件名与检索' },
        source: {
          type: 'string',
          enum: ['voice', 'text', 'paste', 'import'],
          description: '输入方式',
        },
      },
      required: ['text'],
      render: (v) =>
        `已存入 L0：${v.file}\n` +
        `  正文位于第 ${v.startLine}–${v.endLine} 行（文件共 ${v.lines} 行，开头是元信息头）\n` +
        `  引用这段原文时，provenance 请直接用：\n` +
        `    ${v.provenance}\n` +
        `  原文不会被修改。若只引用其中某一句，用 ${v.file}#L<该句行号>。`,
    }),

    // ── 2. 写入主题摘要 ───────────────────────────────────────
    tool({
      name: 'mylife_digest',
      description:
        '写入某主题的 L1 摘要。会同时保留你的原稿与用户确认版，并在两者不一致时标记。' +
        '先给 ai_draft（你的整理），再让用户确认得到 revised —— 二者的差异本身是有价值的信号。',
      properties: {
        topic: { type: 'string', description: '主题' },
        revised: { type: 'string', description: '用户确认后的表述（真正生效的版本）' },
        ai_draft: { type: 'string', description: '你的原始整理，用于后续偏差比对' },
        provenance: {
          type: 'array',
          items: { type: 'string' },
          description: '依据的 L0 指针列表，形如 raw/2026-01-18-001-职业.md#L3-5',
        },
      },
      required: ['topic', 'revised'],
      render: (v) =>
        `已更新摘要「${v.topic}」（第 ${v.revisions} 版）\n` +
        (v.divergent
          ? '⚠️ 当前版本与 AI 原稿不一致 —— 这份差异已保留，可用于校准我今后对你表述的理解。'
          : '当前版本与 AI 原稿一致。'),
    }),

    // ── 3. 新增证据 ───────────────────────────────────────────
    tool({
      name: 'mylife_claim_add',
      description:
        '往 L2 证据图添加一条证据。**必须尽量提供 provenance**（指向 L0 的行号），' +
        '否则这条证据日后无法溯源，也就不该用来支撑任何结论。\n' +
        'kind 的用法：fact=客观可核验；assessment=用户的主观评估（**不是二等公民**，' +
        '它常是决策真正的难点）；inference=你的推断（必须显式标注，用户可否决）。\n' +
        'context 要记下"当时发生了什么" —— 日后还原矛盾时靠它，而不是靠猜。',
      properties: {
        claim: { type: 'string', description: '证据内容，一句话' },
        topic: { type: 'string', description: '主题聚簇键（反证引擎按它聚合）' },
        kind: { type: 'string', enum: ['fact', 'assessment', 'inference', 'unknown'] },
        source: {
          type: 'string',
          enum: ['user_raw', 'user_filled', 'bill_import', 'mcp', 'llm_inferred'],
        },
        provenance: { type: 'string', description: '形如 raw/xxx.md#L12-18' },
        excerpt: { type: 'string', description: '用户原话摘录' },
        context: { type: 'string', description: '当时的语境' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        occurred_at: { type: 'string', description: '该表述发生的时间 YYYY-MM-DD' },
      },
      required: ['claim', 'topic'],
      render: (v) =>
        `已记录证据 ${v.id}\n` +
        `  主题：${v.topic}｜性质：${v.kind}｜来源：${v.source}\n` +
        (v.provenance ? `  出处：${v.provenance}\n` : '  ⚠️ 未提供 provenance —— 这条证据无法溯源，不应单独支撑结论。\n') +
        (v.context ? `  语境：${v.context}` : ''),
    }),

    // ── 4. 检索证据 ───────────────────────────────────────────
    tool({
      name: 'mylife_claim_query',
      description:
        '检索证据图。支持按主题、关键词、状态过滤。' +
        '注意：这是**字面**匹配，不是语义检索。需要跨表述找相关内容时，' +
        '请改用工作区检索工具（zvec-grep / grep）在 raw/ 上做语义召回。',
      properties: {
        topic: { type: 'string', description: '主题（子串匹配）' },
        text: { type: 'string', description: '关键词（子串匹配）' },
        status: {
          type: 'string',
          enum: ['active', 'stale', 'superseded', 'disputed', 'all'],
          description: '默认 active',
        },
      },
      render: (rows) => {
        if (!Array.isArray(rows) || rows.length === 0) {
          return '没有匹配的证据。\n⚠️ 这不等于"没有相关记录"—— 也可能只是关键词没对上，或该主题从未被记录。'
        }
        const lines = [`找到 ${rows.length} 条证据：`]
        for (const r of rows) {
          lines.push(
            `- [${r.id}] (${r.topic}｜${r.kind}｜${r.source}｜${r.occurred_at ?? '时间未知'})` +
              `${r.status && r.status !== 'active' ? ` [${r.status}]` : ''}\n  ${r.claim}`,
          )
        }
        return lines.join('\n')
      },
    }),

    // ── 5. 溯源 ───────────────────────────────────────────────
    tool({
      name: 'mylife_trace',
      description:
        '溯源：把一条证据还原到 L0 原文（含真实文件、行号与原文内容）。' +
        '**在引用任何历史表述之前都应该先调它。**' +
        '若返回 traced=false，说明该证据没有出处 —— 此时不得把它当作事实陈述。',
      properties: {
        id: { type: 'string', description: 'claim id，如 2026-09-17-003' },
        pad: { type: 'integer', description: '前后各多取几行上下文' },
      },
      required: ['id'],
      render: (v) => {
        if (!v.traced) {
          return (
            `⚠️ 无法溯源：${v.reason}\n` +
            `claim：${v.claim?.claim ?? '(未知)'}\n` +
            '**不要把它当作已确认的事实来使用。**'
          )
        }
        const lines = [
          `证据 ${v.id} 溯源到 ${v.file} 第 ${v.range} 行：`,
          '',
          ...v.lines.map((l) => `${l.line}\t${l.text}`),
          '',
          '以上为 L0 原始文本，未经改写。',
        ]
        return lines.join('\n')
      },
    }),

    // ── 6. 时效检查 ───────────────────────────────────────────
    tool({
      name: 'mylife_staleness_check',
      description:
        '检查某个决策所依赖的档案字段是否已过期。' +
        '**在给出任何结论之前都应先调它。**\n' +
        '若返回 blocking 非空，你必须**先请用户确认这些信息**，而不是直接作答。' +
        '给用户的提示里必须包含"沿用旧值"这个选项 —— 否则用户会被卡住。' +
        '若用户选择沿用，你的结论必须显式标注"基于可能过时的数据"并降低确定性。',
      properties: {
        decision: {
          type: 'string',
          description: '决策字段名（先用 mylife_profile_set 建立它及其 depends_on）。省略则检查全部字段。',
        },
      },
      render: (v) => {
        const checked = Array.isArray(v?.checked) ? v.checked : []
        const prompt = renderStalenessPrompt(v ?? {}, v?.decision)
        if (!prompt) {
          return `检查了 ${checked.length} 个字段，均在有效期内，可以正常作答。`
        }
        return prompt
      },
    }),

    // ── 7. 档案字段写入 ───────────────────────────────────────
    tool({
      name: 'mylife_profile_set',
      description:
        '写入/更新一个档案字段。**每个值都必须带 source 与 updated_at**（自动填）。\n' +
        'ttl_days 是有效期天数：省略则按字段名自动推断（学历=不过期、存款=90天、收入=180天…）。' +
        '**首次创建字段时要把推断结果告知用户并请其确认。**\n' +
        'depends_on 是"信息维护"的关键：声明这个决策依赖哪些字段，' +
        '时效检查会据此递归展开。例如「跳槽决策」依赖 ["存款","月收入","现职满意度"]。\n' +
        '决策类字段建议 ttl_days=null（决策本身不过期，但它依赖的字段会）。',
      properties: {
        field: { type: 'string', description: '字段名' },
        value: { description: '值（字符串、数字或数组）' },
        source: {
          type: 'string',
          enum: ['user_filled', 'user_raw', 'bill_import', 'mcp'],
          description: '默认 user_filled。用户口述的数字用 user_filled；从原文抽取用 user_raw。',
        },
        ttl_days: {
          type: 'integer',
          description:
            '有效期天数。null 或省略 = 不过期 / 自动推断。' +
            '注意：连写 JSON Schema 不支持联合类型，所以"不过期"用省略表达。',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: '本字段所依赖的其它字段（用于时效检查）',
        },
        provenance: { type: 'string', description: '出处，如 raw/xxx.md#L5' },
      },
      required: ['field', 'value'],
      render: (v) => {
        const ttl =
          v.ttl_days === null || v.ttl_days === undefined ? '不过期' : `${v.ttl_days} 天`
        const inferred = v.ttl_days === undefined ? '（系统按字段名推断）' : ''
        return (
          `已更新档案字段「${v.field}」= ${JSON.stringify(v.value)}\n` +
          `  来源：${v.source}｜更新于：${v.updated_at}｜有效期：${ttl}${inferred}` +
          (v.depends_on?.length ? `\n  依赖：${v.depends_on.join('、')}` : '')
        )
      },
    }),

    // ── 8. 反证检索 ───────────────────────────────────────────
    tool({
      name: 'mylife_counter_evidence',
      description:
        '**在给出任何正向结论之前必须先调它。** 它会检索两类反证：\n' +
        '  (a) 用户在同一主题上方向相反的多段表述（按时间与语境聚簇）；\n' +
        '  (b) 已作废的旧前提，以及可能已被用户默默放弃的旧约束。\n\n' +
        '输出形态是**还原 + 提问**，不是"检测到你矛盾"。' +
        '请把这个输出**原样呈现给用户**，不要改写成你自己的判断 —— ' +
        '人的多面性不是错误，把综合判断交回用户。\n\n' +
        '若 note 非空，说明未找到反证 —— 但要如实告知用户"这不等于没有反证"。',
      properties: {
        topic: { type: 'string', description: '限定主题（省略则全库）' },
      },
      render: (v) => {
        const parts = []
        for (const f of v.findings ?? []) parts.push(f.rendered)
        if (v.staleOut) parts.push(v.staleOut)
        if (parts.length === 0) return v.note ?? '未找到反证。'
        parts.push('', '---', '以上是需要你确认的地方。请自己判断，我不替你下结论。')
        return parts.join('\n\n')
      },
    }),

    // ── 9. 作废旧前提 ─────────────────────────────────────────
    tool({
      name: 'mylife_supersede',
      description:
        '作废一条已不再成立的证据（旧前提作废）。**必须给出 reason。**\n' +
        '用途：人的旧约束会自动在心里失效，但记录不会 —— 于是会出现' +
        '"拿一年前的恐惧否决今天的决定"。' +
        '当用户确认某条旧约束已不适用时，用它作废，而不是删除（历史要留下）。',
      properties: {
        id: { type: 'string', description: '要作废的 claim id' },
        reason: { type: 'string', description: '为什么它不再成立（必填）' },
        superseded_by: { type: 'string', description: '取代它的新 claim id（若有）' },
      },
      required: ['id', 'reason'],
      render: (v) =>
        `已作废 ${v.id}，状态 → ${v.status}\n  原因：${v.retire_reason}\n` +
        `  原记录保留在 claims/${v.id}.md，未被删除。`,
    }),

    // ── 10. 记录结论与溯源 ────────────────────────────────────
    tool({
      name: 'mylife_conclusion_add',
      description:
        '把你即将给出的结论登记进 L4 溯源索引，并绑定它依据的 claim。\n' +
        '**这条规则是"反谄媚"的技术实现**：任何对外输出的判断都应能在 L4 里落成一条链' +
        '（结论 → claim → L0 原文）。落不成链的判断，说明它没有依据，不该输出。',
      properties: {
        statement: { type: 'string', description: '结论内容' },
        claim_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '支撑该结论的 claim id 列表',
        },
      },
      required: ['statement'],
      render: (v) =>
        `已登记结论 ${v.id}\n  依据：${v.claim_ids?.length ? v.claim_ids.join('、') : '⚠️ 无依据'}\n` +
        (v.claim_ids?.length ? '' : '  ⚠️ 没有依据的结论不应输出给用户。'),
    }),

    // ── 11. 证伪链（反证主路径）──────────────────────────────
    tool({
      name: 'mylife_defeaters',
      description:
        '**在给出任何正向结论之前必须先调它。** 它回答的是"什么能推翻这个判断"。\n\n' +
        '机制：由一个主判断 P 出发，生成若干**证伪项**（若成立则 P 应被推翻），' +
        '分两类：\n' +
        '  · internal —— 用户文中已有的张力\n' +
        '  · gap —— 若成立则 P 被推翻，而判定所需信息**本人能自答但没给**\n' +
        '然后逐条回原文检索，给出四态判定：\n' +
        '  A 原文真的支持它（削弱主判断）\n' +
        '  B 原文用事实否定了它\n' +
        '  R 用户本人已经想过并排除了这一点\n' +
        '  C 原文完全没有相关证据 —— **这是空白**\n\n' +
        '⚠️ 空白（C）是本工具最有价值的输出：它说明"这个决定目前建立在没有数据的区域上"。\n' +
        '⚠️ 请把 rendered 字段**原样呈现给用户**。它的措辞是刻意设计的：' +
        '每条都是提问而非判定，并给出"这两句可能并不矛盾"的出路 —— ' +
        '不要改写成你自己的结论。人的多面性不是错误。',
      properties: {
        proposition: {
          type: 'string',
          description: '主判断，例如"我该离开这家公司"。用用户的说法，不要替他改写。',
        },
        corpus: { type: 'string', description: '要检索的自述原文（省略则用工作区 raw/ 下的内容）' },
        file: { type: 'string', description: '工作区内某篇原文的相对路径，如 raw/2026-09-18-001-职业-随笔.md' },
      },
      required: ['proposition'],
      render: (v) =>
        (v.rendered ?? '（未生成报告）') +
        `\n\n---\n（本次分析了 ${v.corpusChars ?? '?'} 字语料` +
        (v.factsUsed?.length ? ` + ${v.factsUsed.length} 个已知事实：${v.factsUsed.join('、')}` : '，无已知事实') +
        `；` +
        `削弱 ${v.summary?.weakened ?? 0} / 已排除 ${v.summary?.resolved ?? 0} / ` +
        `被否定 ${v.summary?.strengthened ?? 0} / **空白 ${v.summary?.blank ?? 0}**）`,
    }),

    // ── 12. 开场简报 ──────────────────────────────────────────
    tool({
      name: 'mylife_status',
      description:
        '读取"我现在的状态"简报：档案字段及其时效、证据数量与主题、已作废前提、' +
        '以及**没有出处的证据**。\n' +
        '**在会话开始、或用户提到任何历史信息/个人状况时，应先调它。**\n' +
        '它会告诉你哪些信息可能已过时（stale）—— 那些是必须先与用户确认的。',
      properties: {},
      render: (v) => {
        if (!v || !v.fields || !v.claims) return '（简报数据不完整）'
        if (!v.hasAnything) {
          return (
            '档案为空 —— 还没有任何记录。\n' +
            '此时不要假装了解用户。请直接请他描述情况，用 mylife_record 收下原文即可，' +
            '不必要求他先整理好。'
          )
        }
        const lines = ['## 我现在的状态', '']

        const unset = v.fields.unset ?? []
        const blocked = v.blockedDecisions ?? []

        // ⚠️ 空白排在最前。它不是"没问题"，它就是问题本身。
        if (unset.length) {
          lines.push(
            `### ⚠️ 有 ${unset.length} 个字段从未填写 —— 这是空白，不是"没问题"`,
            '',
          )
          for (const f of unset) lines.push(`- **${f.field}**`)
          lines.push('')
        }

        if (blocked.length) {
          lines.push('### 有决策正卡在空白上', '')
          for (const d of blocked) {
            const missing = [...(d.unset ?? []), ...(d.stale ?? [])]
            lines.push(`- **${d.field}**（当前：${JSON.stringify(d.value)}）`)
            lines.push(`  - 缺：${missing.join('、')}`)
          }
          lines.push(
            '',
            '**在回答涉及这些决策的问题之前，先把上面缺的字段问出来。**',
            '给用户的提示里必须包含"暂时跳过"这个选项 —— 不要替他假设数值。',
            '',
          )
        }

        lines.push('## 其余状态', '')
        lines.push(`- 档案字段：${v.fields.total} 个（其中 ${unset.length} 个为空）`)
        if (v.fields.stale.length) {
          lines.push('- ⚠️ 已过期，需先确认：')
          for (const f of v.fields.stale) {
            lines.push(
              `    · ${f.field} = ${JSON.stringify(f.value)}` +
                `（${f.ageDays} 天前，有效期 ${f.ttlDays} 天）`,
            )
          }
        }
        if (v.fields.expiring.length) {
          lines.push(`- 快到有效期：${v.fields.expiring.map((f) => f.field).join('、')}`)
        }
        lines.push(
          `- 证据：${v.claims.active} 条有效` +
            (v.claims.superseded ? `、${v.claims.superseded} 条已作废` : '') +
            (v.claims.disputed ? `、${v.claims.disputed} 条待确认` : ''),
        )
        if (v.claims.topics.length) lines.push(`- 涉及主题：${v.claims.topics.join('、')}`)
        lines.push(`- 已登记结论：${v.conclusions} 条`)

        if (v.unsourcedClaims?.length) {
          lines.push(
            '',
            `⚠️ 有 ${v.unsourcedClaims.length} 条证据没有出处（${v.unsourcedClaims.join('、')}）。` +
              '它们**不得被当作已确认的事实**；引用前请先用 mylife_trace 检查。',
          )
        }
        return lines.join('\n')
      },
    }),
  ]
}

/** 供测试与外部复用。 */
export { text }
