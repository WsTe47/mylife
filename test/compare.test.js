/**
 * before/after 对比测试。
 *
 * 这个模块存在的意义是：把"补上空白会更有依据"从**自我宣称**变成**可检验的断言**。
 * 所以测试也要检验它真的能反映变化，而不是只跑通不报错。
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { setProfileField, addClaim } from '../src/lib/store.js'
import { diffSnapshots, renderComparison, snapshotState } from '../src/lib/compare.js'

let tmp, cfg

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-cmp-'))
  cfg = { workspaceRoot: tmp }
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** 造一个"声明了依赖但部分为空"的决策。 */
async function seedGaps() {
  await setProfileField({ field: '现职满意度', value: '低', ttlDays: 90, config: cfg })
  await setProfileField({ field: '现有存款', value: null, ttlDays: 90, config: cfg })
  await setProfileField({ field: '月税后收入', value: null, ttlDays: 180, config: cfg })
  await setProfileField({
    field: '跳槽决策',
    value: '未定',
    ttlDays: null,
    dependsOn: ['现职满意度', '现有存款', '月税后收入'],
    config: cfg,
  })
}

describe('snapshotState', () => {
  test('正确识别已填 / 未填 / 依赖', async () => {
    await seedGaps()
    const s = await snapshotState({ stage: 'before', decision: '跳槽决策', config: cfg })

    assert.equal(s.stage, 'before')
    assert.ok(s.filled.includes('现职满意度'))
    assert.ok(!s.filled.includes('现有存款'), '空值不该算已填')
    assert.deepEqual(new Set(s.unset), new Set(['现有存款', '月税后收入']))
    assert.deepEqual(
      new Set(s.dependencies),
      new Set(['跳槽决策', '现职满意度', '现有存款', '月税后收入']),
    )
  })

  test('快照不泄露密钥类字段（只取档案字段）', async () => {
    await setProfileField({ field: 'X', value: 1, config: cfg })
    const s = await snapshotState({ stage: 'before', config: cfg })
    assert.ok(!JSON.stringify(s).includes('DEEPSEEK'))
    assert.ok(!JSON.stringify(s).includes('sk-'))
  })

  test('空工作区也能取快照（不崩）', async () => {
    const s = await snapshotState({ stage: 'before', config: cfg })
    assert.equal(s.claims, 0)
    assert.deepEqual(s.filled, [])
  })
})

describe('diffSnapshots', () => {
  test('补上空白后覆盖度上升、可判定性翻转', async () => {
    await seedGaps()
    const before = await snapshotState({ stage: 'before', decision: '跳槽决策', config: cfg })

    await setProfileField({ field: '现有存款', value: 120000, ttlDays: 90, config: cfg })
    await setProfileField({ field: '月税后收入', value: 18000, ttlDays: 180, config: cfg })
    const after = await snapshotState({ stage: 'after', decision: '跳槽决策', config: cfg })

    const d = diffSnapshots(before, after)
    assert.deepEqual(new Set(d.newlyFilled), new Set(['现有存款', '月税后收入']))
    assert.deepEqual(d.stillUnset, [])
    assert.equal(d.wasDecidable, false, '补之前不可判定')
    assert.equal(d.decidable, true, '补之后可判定')
    assert.ok(d.coverage > d.coverageBefore, '覆盖度应上升')
    assert.equal(d.coverage, 1)
  })

  test('只补一部分时仍报告剩余空白', async () => {
    await seedGaps()
    const before = await snapshotState({ stage: 'before', decision: '跳槽决策', config: cfg })
    await setProfileField({ field: '现有存款', value: 120000, ttlDays: 90, config: cfg })
    const after = await snapshotState({ stage: 'after', decision: '跳槽决策', config: cfg })

    const d = diffSnapshots(before, after)
    assert.deepEqual(d.newlyFilled, ['现有存款'])
    assert.deepEqual(d.stillUnset, ['月税后收入'])
    assert.equal(d.decidable, false, '还有空白就不算可判定')
  })

  test('用户选择跳过（保持为空）时如实反映', async () => {
    await seedGaps()
    const before = await snapshotState({ stage: 'before', decision: '跳槽决策', config: cfg })
    // 用户跳过 → 什么都不写
    const after = await snapshotState({ stage: 'after', decision: '跳槽决策', config: cfg })
    const d = diffSnapshots(before, after)
    assert.deepEqual(d.newlyFilled, [])
    assert.deepEqual(new Set(d.stillUnset), new Set(['现有存款', '月税后收入']))
    assert.equal(d.decidable, false)
  })

  test('统计新增证据与新主题', async () => {
    const before = await snapshotState({ stage: 'before', config: cfg })
    await addClaim({ claim: '存款 12 万', topic: '财务', config: cfg })
    await addClaim({ claim: '想跳槽', topic: '职业去留', config: cfg })
    const after = await snapshotState({ stage: 'after', config: cfg })

    const d = diffSnapshots(before, after)
    assert.equal(d.claimsAdded, 2)
    assert.deepEqual(new Set(d.newTopics), new Set(['财务', '职业去留']))
  })
})

describe('renderComparison 措辞纪律', () => {
  test('陈述机械差异，不替用户判断"结论更可靠了"', async () => {
    await seedGaps()
    const before = await snapshotState({ stage: 'before', decision: '跳槽决策', config: cfg })
    await setProfileField({ field: '现有存款', value: 120000, ttlDays: 90, config: cfg })
    await setProfileField({ field: '月税后收入', value: 18000, ttlDays: 180, config: cfg })
    const after = await snapshotState({ stage: 'after', decision: '跳槽决策', config: cfg })

    const text = renderComparison({ before, after })

    assert.ok(text.includes('填充覆盖率'))
    assert.ok(text.includes('现有存款'))
    // 不得替用户下"更可靠/更正确"的判断
    for (const forbidden of ['结论更可靠', '更正确', '你应该', '显然']) {
      assert.ok(!text.includes(forbidden), `不应出现：${forbidden}`)
    }
    assert.ok(text.includes('那是你的判断'), '必须把判断交回用户')
  })

  test('仍有空白时必须标注不确定性', async () => {
    await seedGaps()
    const before = await snapshotState({ stage: 'before', decision: '跳槽决策', config: cfg })
    await setProfileField({ field: '现有存款', value: 1, ttlDays: 90, config: cfg })
    const after = await snapshotState({ stage: 'after', decision: '跳槽决策', config: cfg })

    const text = renderComparison({ before, after })
    assert.ok(text.includes('仍然是空白的'))
    assert.ok(text.includes('必须标注不确定性'))
    assert.ok(text.includes('仍然不可判定'))
  })

  test('全部补齐时说明已具备数据基础', async () => {
    await seedGaps()
    const before = await snapshotState({ stage: 'before', decision: '跳槽决策', config: cfg })
    await setProfileField({ field: '现有存款', value: 1, ttlDays: 90, config: cfg })
    await setProfileField({ field: '月税后收入', value: 1, ttlDays: 180, config: cfg })
    const after = await snapshotState({ stage: 'after', decision: '跳槽决策', config: cfg })

    const text = renderComparison({ before, after })
    assert.ok(text.includes('具备了数据基础'))
  })

  test('覆盖度为 0 时不出现 NaN', async () => {
    const s = await snapshotState({ stage: 'before', config: cfg })
    const text = renderComparison({ before: s, after: s })
    assert.ok(!text.includes('NaN'), '除零必须被处理')
  })
})
