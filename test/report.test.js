/**
 * 决策报告装配测试。
 *
 * 重点守两件事：
 *   1. **可判定性由数据决定，不由情绪决定** —— 依赖字段有空白时必须声明"不可判定"
 *   2. **报告形状不可省略任何一段** —— 少一段就等于悄悄关掉一个反方渠道
 *
 * 全部用 stub llm，不烧 API。
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { addClaim, recordRaw, setProfileField } from '../src/lib/store.js'
import { assembleReport, assessDecidability, renderReport, verifyTraceability } from '../src/lib/report.js'

let tmp, cfg
let call = 0

/** stub：生成阶段两条证伪项，检索阶段一条 A 一条 C。 */
function stubLlm() {
  call = 0
  return async (msgs) => {
    if (msgs[0].content.includes('生成证伪项')) {
      return JSON.stringify({ defeaters: [
        { label: '领导认可足以留住他', proposition: '领导认可足以留住他', type: 'internal', tension_between: '感激 / 离开' },
        { label: '存款能撑几个月', proposition: '存款能撑几个月', type: 'gap', evidence_needed: '存款月数' },
      ] })
    }
    call += 1
    return call === 1
      ? JSON.stringify({ verdict: 'A', quotes: ['我做的活没什么问题'], note: '支持' })
      : JSON.stringify({ verdict: 'C', quotes: [], note: '无证据' })
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-rep-'))
  cfg = { workspaceRoot: tmp }
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('assessDecidability（可判定性）', () => {
  test('有未填字段时不可判定，并说明原因', () => {
    const r = assessDecidability({
      staleness: { unset: [{ field: '现有存款' }, { field: '月税后收入' }], checked: ['现职满意度', '现有存款', '月税后收入'] },
    })
    assert.equal(r.decidable, false)
    assert.equal(r.reasons.length, 1)
    assert.ok(r.reasons[0].includes('现有存款'))
  })

  test('证伪链的空白也算不可判定的理由', () => {
    const r = assessDecidability({
      staleness: { unset: [], checked: ['a'] },
      defeaters: { results: [{ verdict: 'C', label: '存款能撑几个月' }] },
    })
    assert.equal(r.decidable, false)
    assert.ok(r.reasons.some((x) => x.includes('存款能撑几个月')))
  })

  test('字段齐 + 无空白 → 可判定', () => {
    const r = assessDecidability({
      staleness: { unset: [], checked: ['a', 'b'] },
      defeaters: { results: [{ verdict: 'A', label: 'x' }] },
    })
    assert.equal(r.decidable, true)
    assert.deepEqual(r.reasons, [])
  })

  test('证伪链未运行时，只看字段（不因缺证伪链而误判为可判定）', () => {
    const r = assessDecidability({ staleness: { unset: [], checked: ['a'] }, defeaters: null })
    assert.equal(r.decidable, true)
  })
})

describe('assembleReport', () => {
  test('依赖字段有空白时给出不可判定', async () => {
    await setProfileField({ field: '现有存款', value: null, ttlDays: 90, config: cfg })
    await setProfileField({
      field: '我该离开这家公司', value: '未定', ttlDays: null,
      dependsOn: ['现有存款'], config: cfg,
    })

    const r = await assembleReport({
      proposition: '我该离开这家公司', corpus: '一段自述', llm: stubLlm(), config: cfg,
    })
    assert.equal(r.decidability.decidable, false)
    assert.ok(r.decidability.reasons.some((x) => x.includes('现有存款')))
    assert.ok(r.defeaters, '证伪链应已运行')
  })

  test('字段齐 + 无空白 → 可判定', async () => {
    await setProfileField({ field: '现有存款', value: 120000, ttlDays: 90, config: cfg })
    await setProfileField({
      field: '我该离开这家公司', value: '未定', ttlDays: null,
      dependsOn: ['现有存款'], config: cfg,
    })
    const r = await assembleReport({
      proposition: '我该离开这家公司', corpus: 'x',
      llm: async (msgs) => msgs[0].content.includes('生成证伪项')
        ? JSON.stringify({ defeaters: [{ label: 'a', proposition: 'a', type: 'gap' }] })
        : JSON.stringify({ verdict: 'A' }),
      config: cfg,
    })
    assert.equal(r.decidability.decidable, true)
  })

  test('证伪链失败时报告仍能产出，但如实标注错误', async () => {
    await setProfileField({ field: '我该离开这家公司', value: '未定', ttlDays: null, config: cfg })
    const r = await assembleReport({
      proposition: '我该离开这家公司', corpus: 'x',
      llm: async () => { throw new Error('网络抖了') },
      config: cfg,
    })
    assert.equal(r.defeaters, null)
    assert.match(r.defeaterError, /网络抖了/)
    const text = renderReport(r)
    assert.ok(text.includes('证伪链未能运行'), '必须显式告警，不能静默跳过')
    assert.ok(text.includes('缺少反方检验'))
  })

  test('skipDefeaters 时不报错，但报告里注明缺少反方检验', async () => {
    await setProfileField({ field: 'P', value: 1, ttlDays: null, config: cfg })
    const r = await assembleReport({ proposition: 'P', corpus: 'x', skipDefeaters: true, config: cfg })
    assert.equal(r.defeaters, null)
    assert.equal(r.defeaterError, null)
    const text = renderReport(r)
    assert.ok(text.includes('缺少反方检验'))
  })

  test('标出无出处的证据', async () => {
    await setProfileField({ field: 'P', value: 1, ttlDays: null, config: cfg })
    await addClaim({ claim: '没有出处的一条', topic: 't', config: cfg })
    const r = await assembleReport({ proposition: 'P', corpus: 'x', skipDefeaters: true, config: cfg })
    assert.equal(r.unsourcedClaims.length, 1)
    assert.ok(renderReport(r).includes('没有出处'))
  })
})

describe('renderReport 形状纪律', () => {
  test('八个段落一个都不能少', async () => {
    await setProfileField({ field: 'P', value: 1, ttlDays: null, config: cfg })
    const r = await assembleReport({ proposition: 'P', corpus: 'x', llm: stubLlm(), config: cfg })
    const text = renderReport(r, {
      actions: [['算清财务底线', '一个数字', '写进档案']],
      ifWrong: ['把价值观不合当成主因'],
      changeSignals: [['面试拿不到 offer', '先补能力']],
    })
    for (const section of [
      '一、这个判断现在能不能下',
      '二、什么能推翻这个判断',
      '三、信息状态',
      '四、证据',
      '五、行动',
      '六、如果你错了',
      '七、什么信号出现就该改主意',
      '免责',
    ]) {
      assert.ok(text.includes(section), `缺少段落：${section}`)
    }
  })

  test('未提供行动/改判条件时如实写"未提供"，不留空', async () => {
    await setProfileField({ field: 'P', value: 1, ttlDays: null, config: cfg })
    const r = await assembleReport({ proposition: 'P', corpus: 'x', skipDefeaters: true, config: cfg })
    const text = renderReport(r)
    assert.ok(text.includes('（未提供行动项。）'))
    assert.ok(text.includes('（未提供。）'))
  })

  test('头部统计正确反映被依赖字段与未填数', async () => {
    await setProfileField({ field: 'A', value: 1, ttlDays: null, config: cfg })
    await setProfileField({ field: 'B', value: null, ttlDays: null, config: cfg })
    await setProfileField({ field: 'P', value: 'x', ttlDays: null, dependsOn: ['A', 'B'], config: cfg })
    const r = await assembleReport({ proposition: 'P', corpus: 'x', skipDefeaters: true, config: cfg })
    const text = renderReport(r)
    assert.ok(text.includes('被依赖字段'), '应有字段统计')
    assert.ok(text.includes('从未填写'), '应标出未填数')
    assert.ok(!text.includes('NaN'))
  })
})

describe('verifyTraceability（锚定证据的可检验形式）', () => {
  test('能溯源的比例被如实报告', async () => {
    const raw = await recordRaw({ text: 'A\nB\nC', topic: 't', config: cfg })
    const good = await addClaim({
      claim: '有出处', topic: 't', provenance: `${raw.file}#L${raw.startLine}`, config: cfg,
    })
    const bad = await addClaim({ claim: '没出处', topic: 't', config: cfg })

    const v = await verifyTraceability({ ids: [good.id, bad.id], config: cfg })
    assert.equal(v.checked, 2)
    assert.equal(v.traced, 1)
    assert.deepEqual(v.failed, [bad.id])
  })

  test('不存在的 id 算失败而不是抛错', async () => {
    const v = await verifyTraceability({ ids: ['不存在'], config: cfg })
    assert.equal(v.traced, 0)
    assert.deepEqual(v.failed, ['不存在'])
  })

  test('空列表不崩', async () => {
    const v = await verifyTraceability({ ids: [], config: cfg })
    assert.deepEqual(v, { checked: 0, traced: 0, failed: [] })
  })
})
