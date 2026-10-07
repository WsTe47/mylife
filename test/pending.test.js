/**
 * pending（闭环入口）测试。
 *
 * 守两条不可退让的约束：
 *   1. **必须给"跳过"的出路** —— 否则用户会被卡住，那不是他想要的
 *   2. **绝不替用户假设数值** —— 跳过/不清楚都不能变成编出来的值
 *
 * 另守一条实现约束：0 与 false 是有效值，不能被当成空白。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  draftQuestion,
  interpretAnswer,
  pendingItems,
  planProfileUpdates,
  unsetFields,
} from '../src/lib/pending.js'
import { execute } from '../src/tools/execute.js'
import { createTools } from '../src/tools/index.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('draftQuestion（模板优先）', () => {
  test('常见字段命中对应模板，且都带示例', () => {
    const cases = [
      ['现有存款', /多少/, /数量级|万/],
      ['月税后收入', /多少/, /万|税后/],
      ['月刚性支出', /多少/, /房租|8000/],
      ['信用卡负债', /多少/, /分期|万/],
      ['外部机会可得性', /状况/, /投|面/],
      ['降薪或转岗接受度', /底线/, /降薪|换组/],
    ]
    for (const [field, qRe, hintRe] of cases) {
      const d = draftQuestion(field)
      assert.ok(qRe.test(d.question), `${field} 的问题不含预期内容：${d.question}`)
      assert.ok(hintRe.test(d.hint), `${field} 缺少有用的示例：${d.hint}`)
      assert.ok(d.question.includes(field), '问句里应出现字段名')
    }
  })

  test('⚠️ 非财务字段不得被问成钱（真实 bug：年假余额 → "10–15 万"）', () => {
    // 病根：模板表里没有「假期」类模式，而「年假余额」含「余额」二字，
    // 被存款模板抢走，于是问出金额示例 —— 明显答非所问。
    const d = draftQuestion('年假余额')
    assert.ok(!/万|数量级/.test(d.hint), `假期字段不该给金额示例，实际给了：${d.hint}`)
    assert.ok(/天/.test(d.hint), '假期字段的示例应带天数')
    assert.ok(!/多少/.test(d.question), '不该问"是多少"（听起来像在问钱）')
  })

  test('各类假期字段都走假期模板', () => {
    for (const f of ['年假余额', '剩余年假', '调休天数', '带薪假', '请假余额']) {
      const d = draftQuestion(f)
      assert.ok(!/万/.test(d.hint), `${f} 不该给金额示例`)
      assert.ok(/天|必须休完|剩余/.test(d.hint), `${f} 的示例应贴切假期：${d.hint}`)
    }
  })

  test('假期模板不得抢走真正的财务字段', () => {
    assert.ok(/万/.test(draftQuestion('现有存款').hint), '存款仍应是金额示例')
    assert.ok(/税后|万/.test(draftQuestion('月税后收入').hint), '收入仍应是金额示例')
  })

  test('通用回退的示例不暗示"钱"', () => {
    const d = draftQuestion('学历')
    assert.ok(!/万|数量级|钱/.test(d.hint), `回退示例不该暗示钱：${d.hint}`)
  })

  test('未知字段回退到通用问法，但仍带示例', () => {
    const d = draftQuestion('某个我从没见过的字段')
    assert.ok(d.question.includes('某个我从没见过的字段'))
    assert.ok(d.hint.length > 0, '回退也必须给示例')
    assert.ok(/没有依据/.test(d.question), '回退问法应说明这是空白')
  })

  test('note 会作为 why 带出来（说明为什么需要它）', () => {
    const d = draftQuestion('现有存款', { note: '「跳槽决策」依赖它' })
    assert.equal(d.why, '「跳槽决策」依赖它')
  })
})

describe('unsetFields', () => {
  test('null / undefined / 空串 算空白', () => {
    const out = unsetFields({
      a: { value: null },
      b: { value: undefined },
      c: { value: '   ' },
      d: { value: '有值' },
    })
    assert.deepEqual(out.map((x) => x.field).sort(), ['a', 'b', 'c'])
  })

  test('0 与 false 是有效值，不算空白', () => {
    const out = unsetFields({
      结余: { value: 0 },
      已婚: { value: false },
    })
    assert.deepEqual(out, [], '0 与 false 必须被视为已填 —— 它们是有意义的事实')
  })

  test('空档案返回空数组', () => {
    assert.deepEqual(unsetFields(null), [])
    assert.deepEqual(unsetFields({}), [])
  })
})

describe('pendingItems', () => {
  const fields = {
    现有存款: { value: null, provenance: '待填写' },
    月税后收入: { value: null },
    现职满意度: { value: '低' },
    跳槽决策: { value: '未定', depends_on: ['现有存款', '月税后收入', '现职满意度'] },
  }

  test('汇总全档案空白 + 决策卡点 + 现成问句', () => {
    const r = pendingItems({
      fields,
      decisions: [
        { field: '跳槽决策', value: '未定', decidable: false, unset: ['现有存款', '月税后收入'], stale: [] },
      ],
    })
    assert.equal(r.unset.length, 2, '两个空字段')
    assert.equal(r.blockedDecisions.length, 1)
    assert.deepEqual(r.blockedDecisions[0].missing, ['现有存款', '月税后收入'])
    assert.equal(r.questions.length, 2, '每个空白一条问句')
    // 卡住决策的问句应带 why
    assert.ok(r.questions[0].why?.includes('跳槽决策'), '应说明为什么需要这个字段')
  })

  test('问句不重复（同一字段只出现一次）', () => {
    const r = pendingItems({
      fields,
      decisions: [
        { field: 'A', value: 'x', decidable: false, unset: ['现有存款'], stale: [] },
        { field: 'B', value: 'y', decidable: false, unset: ['现有存款'], stale: [] },
      ],
    })
    const fields_ = r.questions.map((q) => q.field)
    assert.equal(new Set(fields_).size, fields_.length, '同一字段不该问两遍')
  })

  test('过期字段用不同问法（确认而非首次填写）', () => {
    const r = pendingItems({
      fields: { 存款: { value: 120000, updated_at: '2020-01-01', ttl_days: 90 } },
      staleness: {
        decision: '裸辞决策',
        blocking: [{ field: '存款', ageDays: 2000, ttlDays: 90, value: 120000 }],
      },
    })
    const q = r.questions.find((x) => x.field === '存款')
    assert.ok(q, '过期字段也要问')
    assert.equal(q.stale, true, '应标记为 stale（与首次填写区分）')
    assert.ok(q.why?.includes('2000'), '应带上多久没更新')
  })

  test('决策可判定时不进 blockedDecisions', () => {
    const r = pendingItems({
      fields: { A: { value: 1 } },
      decisions: [{ field: 'D', value: 'x', decidable: true, unset: [], stale: [] }],
    })
    assert.deepEqual(r.blockedDecisions, [])
  })

  test('无缺口时 total 为 0', () => {
    const r = pendingItems({ fields: { A: { value: 1 } }, decisions: [] })
    assert.equal(r.total, 0)
    assert.deepEqual(r.questions, [])
  })
})

describe('interpretAnswer（必须如实）', () => {
  test('正常回答 → answered，值原样保留', () => {
    const r = interpretAnswer('大概 12 万')
    assert.equal(r.status, 'answered')
    assert.equal(r.value, '大概 12 万', '不得改写用户的话')
  })

  test('各种跳过说法都要识别出来', () => {
    for (const s of ['跳过', '先跳过', '不填', '不想说', '以后再说', 'skip', 'Pass']) {
      const r = interpretAnswer(s)
      assert.equal(r.status, 'skipped', `「${s}」应被判为跳过`)
      assert.equal(r.value, null, '跳过绝不能产生数值')
      assert.ok(r.note?.includes('无依据'), '跳过必须留下"无依据"的标记')
    }
  })

  test('表示不清楚 → unclear，不算答了也不算跳过', () => {
    for (const s of ['不知道', '没算过', '记不清']) {
      const r = interpretAnswer(s)
      assert.equal(r.status, 'unclear', `「${s}」应是 unclear`)
      assert.equal(r.value, null, '不清楚绝不能变成编出来的值')
    }
  })

  test('空回答 → unclear', () => {
    assert.equal(interpretAnswer('').status, 'unclear')
    assert.equal(interpretAnswer('   ').status, 'unclear')
  })

  test('「不知道要不要换城市」这类长句不算"不清楚"（是真实回答）', () => {
    // 短前缀匹配容易误伤 —— 这条守住边界
    const r = interpretAnswer('不知道要不要换城市，纠结很久了')
    assert.equal(r.status, 'answered')
  })

  test('0 作为回答是有效值', () => {
    const r = interpretAnswer('0')
    assert.equal(r.status, 'answered')
    assert.equal(r.value, '0')
  })
})

describe('planProfileUpdates', () => {
  test('分流出 answered / skipped / unclear', () => {
    const r = planProfileUpdates([
      { field: '现有存款', raw: '12 万' },
      { field: '月税后收入', raw: '跳过' },
      { field: '月刚性支出', raw: '不知道' },
      { field: '外部机会', raw: '还没开始投' },
    ])
    assert.deepEqual(r.updates.map((u) => u.field), ['现有存款', '外部机会'])
    assert.deepEqual(r.skipped, ['月税后收入'])
    assert.deepEqual(r.unclear, ['月刚性支出'])
  })

  test('跳过与不清楚都不得进入 updates（不能编数值）', () => {
    const r = planProfileUpdates([
      { field: 'A', raw: '跳过' },
      { field: 'B', raw: '不知道' },
    ])
    assert.deepEqual(r.updates, [], '绝不能替用户假设数值')
  })

  test('空输入不崩', () => {
    assert.deepEqual(planProfileUpdates(), { updates: [], skipped: [], unclear: [] })
  })
})


// ─────────────────────────────────────────────────────────────
// 工具层：闭环四件套
// ─────────────────────────────────────────────────────────────

describe('闭环四件套（工具层集成）', () => {
  let tmp, cfg
  const T = (n) => createTools(cfg).find((t) => t.name === n)
  const text = (n, v) => T(n).output.render({}, v)[0].text

  /**
   * 复刻 harness 对工具返回值的 lossless-JSON 校验
   * （dsh-util-values 的 snapshotJsonValue）：出现 undefined / NaN / 函数，
   * **整个工具调用**会被拒绝（"value is not lossless JSON"），用户什么都看不到。
   */
  function lossless(value, seen = new Set()) {
    if (value === null) return true
    const t = typeof value
    if (t === 'boolean' || t === 'string') return true
    if (t === 'number') return Number.isFinite(value) && !Object.is(value, -0)
    if (t !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    const ok = Array.isArray(value)
      ? value.every((item) => lossless(item, seen))
      : Object.values(value).every((item) => lossless(item, seen))
    seen.delete(value)
    return ok
  }

  async function seed() {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-loop-'))
    cfg = { workspaceRoot: tmp }
    await execute('mylife_profile_set', { field: '现有存款', value: null, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', { field: '跳槽决策', value: '未定', ttl_days: null, depends_on: ['现有存款'] }, cfg)
  }

  test('pending 报出卡点并给出可直接用的问句', async () => {
    await seed()
    const p = await execute('mylife_pending', {}, cfg)
    assert.equal(p.unset.length, 1)
    assert.equal(p.blockedDecisions.length, 1)
    const t = text('mylife_pending', p)
    assert.ok(t.includes('卡在空白上'))
    assert.ok(t.includes('你的「现有存款」大概是多少？'), '应给出成品问句')
    assert.ok(t.includes('示例'), '必须带示例')
    assert.ok(t.includes('跳过'), '必须保留跳过出路')
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('ask 模板命中时不调 LLM', async () => {
    await seed()
    const a = await execute('mylife_ask', { field: '现有存款' }, cfg)
    assert.equal(a.drafted_by, 'template')
    assert.ok(text('mylife_ask', a).includes('跳过'))
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('answer：回答写入，跳过不写入', async () => {
    await seed()
    const ok = await execute('mylife_answer', { field: '现有存款', answer: '12 万' }, cfg)
    assert.equal(ok.status, 'answered')
    assert.equal(ok.value, '12 万')

    await execute('mylife_profile_set', { field: '外部机会', value: null, ttl_days: 90 }, cfg)
    const skip = await execute('mylife_answer', { field: '外部机会', answer: '跳过' }, cfg)
    assert.equal(skip.status, 'skipped')
    assert.equal(skip.written, false, '跳过不得写档案')

    const { readProfile } = await import('../src/lib/store.js')
    const f = await readProfile({ config: cfg })
    assert.equal(f['现有存款'].value, '12 万')
    assert.equal(f['外部机会'].value, null, '跳过绝不能产生数值')
    await fs.rm(tmp, { recursive: true, force: true })
  })

  // 回归：answer 作用在一个**档案里还不存在的新字段**、且没传 ttl_days 时，
  // 曾因 setProfileField 没写 ttl_days 键而返回 `{ ttl_days: undefined }`，
  // 让 harness 的 lossless-JSON 校验拒绝整个工具调用。
  // 已有字段碰巧带着 ttl_days，所以上面那条测试一直没抓到。
  test('answer：新字段省略 ttl_days 时，返回值仍是无损 JSON', async () => {
    await seed()
    const r = await execute(
      'mylife_answer',
      { field: '请假期间是否需要处理工作', answer: '大概不需要，但要随时 oncall' },
      cfg,
    )
    assert.equal(r.status, 'answered')
    assert.ok(
      Number.isInteger(r.ttl_days) || r.ttl_days === null,
      `ttl_days 必须是数字或 null，实际是 ${String(r.ttl_days)}`,
    )
    assert.equal(r.ttl_inferred, true, '新字段的有效期是推断的，必须标明')
    assert.ok(lossless(r), '返回值必须落在无损 JSON 范围内')
    assert.ok(
      text('mylife_answer', r).includes('推断'),
      '推断出来的有效期要告诉用户，别假装是他自己定的',
    )

    const { readProfile } = await import('../src/lib/store.js')
    const f = await readProfile({ config: cfg })
    assert.equal(f['请假期间是否需要处理工作'].ttl_days, r.ttl_days, '写进档案的有效期要对得上')
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('answer：已有字段省略 ttl_days 时，不覆盖它原有的有效期', async () => {
    await seed()
    const r = await execute('mylife_answer', { field: '现有存款', answer: '12 万' }, cfg)
    assert.equal(r.ttl_days, 90, '存款原本就是 90 天，不该被重新推断改掉')
    assert.equal(r.ttl_inferred, false, '沿用了已有值，不算推断')
    assert.ok(lossless(r))
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('recompute：首次无基线，填后能看到差异', async () => {
    await seed()
    const first = await execute('mylife_recompute', { decision: '跳槽决策' }, cfg)
    assert.equal(first.baseline, false)
    assert.ok(first.rendered.includes('没有可对比的基线'), '不得假装有对比')

    await execute('mylife_answer', { field: '现有存款', answer: '12 万' }, cfg)
    const second = await execute('mylife_recompute', { decision: '跳槽决策' }, cfg)
    assert.equal(second.baseline, true)
    assert.equal(second.diff.coverage, 1)
    assert.equal(second.diff.decidable, true)
    const t = text('mylife_recompute', second)
    assert.ok(t.includes('填充覆盖率'))
    assert.ok(t.includes('那是你的判断'), '不得替用户判断结论更可靠')
    await fs.rm(tmp, { recursive: true, force: true })
  })
})


describe('与 mylife_staleness_check 的分工（文档 6.3.1 的断言）', () => {
  let tmp, cfg

  test('pending 能看到「没接进依赖链」的空白，staleness 看不到', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-div-'))
    cfg = { workspaceRoot: tmp }

    await execute('mylife_profile_set', { field: '现职满意度', value: '低', ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', { field: '现有存款', value: null, ttl_days: 90 }, cfg)
    // 这个字段没有任何决策依赖它 —— 属于"没接线的空白"
    await execute('mylife_profile_set', { field: '某段没接线的空白字段', value: null, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', {
      field: '跳槽决策', value: '未定', ttl_days: null, depends_on: ['现职满意度', '现有存款'],
    }, cfg)

    const st = await execute('mylife_staleness_check', { decision: '跳槽决策' }, cfg)
    const pd = await execute('mylife_pending', {}, cfg)

    // staleness 是单决策投影：只看该决策的依赖链
    assert.deepEqual(st.unset.map((x) => x.field), ['现有存款'])
    // pending 是全档案投影：能看到接线外的空白
    assert.ok(
      pd.unset.map((x) => x.field).includes('某段没接线的空白字段'),
      'pending 必须能报出没接进依赖链的空白 —— 这是它存在的理由',
    )
    assert.ok(
      !st.unset.map((x) => x.field).includes('某段没接线的空白字段'),
      'staleness 只服务单个决策，看不到接线外的字段（不是缺陷，是分工）',
    )

    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('对同一个决策，两者判断一致（pending 内部就是用 checkStaleness 算的）', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-div2-'))
    cfg = { workspaceRoot: tmp }
    await execute('mylife_profile_set', { field: 'A', value: null, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', { field: 'B', value: null, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', {
      field: 'D', value: 'x', ttl_days: null, depends_on: ['A', 'B'],
    }, cfg)

    const st = await execute('mylife_staleness_check', { decision: 'D' }, cfg)
    const pd = await execute('mylife_pending', {}, cfg)
    const blocked = pd.blockedDecisions.find((d) => d.field === 'D')

    assert.deepEqual(
      [...st.unset.map((x) => x.field)].sort(),
      [...(blocked?.missing ?? [])].sort(),
      '两者对同一决策的缺项清单必须一致 —— 不存在谁更权威',
    )
    await fs.rm(tmp, { recursive: true, force: true })
  })
})
