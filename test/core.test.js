/**
 * MyLife 核心库测试。
 *
 * 跑：node --test test/
 *
 * 覆盖：四层读写、时效引擎、反证引擎，以及几条**不可退让的不变式**：
 *   - L0 原始层只增不改
 *   - 溯源必须能回到真实行号
 *   - 反证输出必须是提问而非指控
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  addClaim,
  layout,
  queryClaims,
  readDigest,
  readIndex,
  readProfile,
  recordRaw,
  rebuildClaimIndex,
  setProfileField,
  supersedeClaim,
  traceClaim,
  writeDigest,
} from '../src/lib/store.js'
import { ensureWorkspace, nextId, isInside, resolveRoot } from '../src/lib/workspace.js'
import {
  checkStaleness,
  fieldFreshness,
  inferTtlDays,
  isEmptyValue,
  renderStalenessPrompt,
  resolveDependencies,
} from '../src/lib/fields.js'
import { buildCounterEvidence, clusterByTopic, findTensions, polarityOf, renderRestoration } from '../src/lib/evidence.js'

let tmp
let config

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-test-'))
  config = { workspaceRoot: tmp }
  await ensureWorkspace(tmp)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────

describe('workspace', () => {
  test('layout 给出四层路径且互不相同', () => {
    const l = layout('/tmp/x')
    const keys = ['raw', 'digest', 'claims', 'claimIndex', 'profile', 'trace']
    const values = keys.map((k) => l[k])
    assert.equal(new Set(values).size, values.length, '路径不应重复')
    assert.ok(l.claimIndex.startsWith(l.claims), 'claimIndex 应在 claims 目录下')
  })

  test('resolveRoot 展开 ~', () => {
    const root = resolveRoot({ workspaceRoot: '~/mylife-probe' })
    assert.equal(root, path.join(os.homedir(), 'mylife-probe'))
    assert.ok(!root.includes('~'))
  })

  test('isInside 阻断目录穿越', () => {
    assert.ok(isInside('/a/b', '/a/b/c/d'))
    assert.ok(isInside('/a/b', '/a/b'))
    assert.ok(!isInside('/a/b', '/a/bc'))
    assert.ok(!isInside('/a/b', '/a'))
    assert.ok(!isInside('/a/b', '/a/b/../../etc'))
  })

  test('nextId 同日递增且补零', () => {
    const day = new Date('2026-09-17T10:00:00')
    assert.equal(nextId([], day), '2026-09-17-001')
    assert.equal(nextId(['2026-09-17-001'], day), '2026-09-17-002')
    assert.equal(nextId(['2026-09-17-001', '2026-09-17-002'], day), '2026-09-17-003')
    // 跨越日期不互相影响
    assert.equal(nextId(['2026-09-16-007'], day), '2026-09-17-001')
  })
})

// ─────────────────────────────────────────────────────────────

describe('L0 原始层', () => {
  test('原文一字不改地保留（含错别字与语病）', async () => {
    const messy = '我我我今天很乱，不知道道该怎么办。。。学历的事情其实我早就不在意了'
    const { file } = await recordRaw({ text: messy, topic: '职业', source: 'voice', config })
    const saved = await fs.readFile(path.join(tmp, file), 'utf8')
    assert.ok(saved.includes(messy), '原文必须逐字保留')
  })

  test('多次记录不会覆盖，且同日序号递增', async () => {
    const a = await recordRaw({ text: '第一条', topic: '职业', config })
    const b = await recordRaw({ text: '第二条', topic: '财务', config })
    assert.notEqual(a.file, b.file)
    const first = await fs.readFile(path.join(tmp, a.file), 'utf8')
    assert.ok(first.includes('第一条'))
    assert.ok(!first.includes('第二条'), '新记录不得污染旧文件')
  })

  test('返回的 provenance 精确指向正文（不能指到元信息头或空行）', async () => {
    const text = '第一句：很迷茫。\n第二句：不知道要不要换城市。'
    const r = await recordRaw({ text, topic: '验证', config })

    // 用返回的指针去读文件，取到的必须**正好是正文**
    const saved = await fs.readFile(path.join(tmp, r.file), 'utf8')
    const all = saved.split('\n')
    const body = all.slice(r.startLine - 1, r.endLine)
    assert.deepEqual(body, text.split('\n'), 'startLine/endLine 必须精确框住正文')

    // provenance 格式正确且指向同一区间
    assert.equal(r.provenance, `${r.file}#L${r.startLine}-${r.endLine}`)

    // 这是关键回归：曾经的缺陷是只返回总行数，agent 猜行号猜到了末尾空行
    assert.notEqual(r.startLine, r.lines, '正文不应从文件末尾开始')
    assert.notEqual(all[r.startLine - 1].trim(), '', '起始行不能是空行')
  })

  test('多行正文的行区间正确', async () => {
    const r = await recordRaw({ text: 'A\nB\nC\nD', topic: 't', config })
    const saved = await fs.readFile(path.join(tmp, r.file), 'utf8')
    const body = saved.split('\n').slice(r.startLine - 1, r.endLine)
    assert.deepEqual(body, ['A', 'B', 'C', 'D'])
  })

  test('空文本被拒绝', async () => {
    await assert.rejects(() => recordRaw({ text: '   ', config }), /text 不能为空/)
  })

  test('主题名中的路径分隔符被安全化', async () => {
    const { file } = await recordRaw({ text: 'x', topic: '../evil/path', config })
    assert.ok(!file.includes('..'), '不得逃出工作区')
    assert.ok(file.startsWith('raw/'))
  })
})

// ─────────────────────────────────────────────────────────────

describe('L1 摘要层', () => {
  test('同时保留 AI 原稿与用户修订版', async () => {
    const r = await writeDigest({
      topic: '职业去留',
      revised: '我认可工作内容，但不认可当前强度',
      aiDraft: '用户在职业上存在矛盾心态',
      config,
    })
    assert.equal(r.revisions, 1)
    const d = await readDigest({ topic: '职业去留', config })
    assert.ok(d.body.includes('我认可工作内容，但不认可当前强度'))
    assert.ok(d.body.includes('用户在职业上存在矛盾心态'))
    assert.equal(d.ai_draft, '用户在职业上存在矛盾心态')
  })

  test('修订与原稿不一致时标记 divergent', async () => {
    await writeDigest({ topic: 't', revised: 'A', aiDraft: 'B', config })
    const d = await readDigest({ topic: 't', config })
    assert.equal(d.divergent, true)
  })

  test('修订与原稿一致时不标记 divergent', async () => {
    await writeDigest({ topic: 't2', revised: '同一个说法', aiDraft: '同一个说法', config })
    const d = await readDigest({ topic: 't2', config })
    assert.equal(d.divergent, false)
  })

  test('重复写入累加 revisions 并保留 created_at', async () => {
    const first = await writeDigest({ topic: 't3', revised: 'v1', config })
    const second = await writeDigest({ topic: 't3', revised: 'v2', config })
    assert.equal(second.revisions, 2)
    const d = await readDigest({ topic: 't3', config })
    assert.equal(d.created_at, first.created_at ?? d.created_at)
  })
})

// ─────────────────────────────────────────────────────────────

describe('L2 证据图', () => {
  test('一条证据一个文件，index.yaml 自动重建', async () => {
    await addClaim({ claim: '我无法忍受当前的管理方式', topic: '职业去留', kind: 'assessment', config })
    await addClaim({ claim: '月税后收入约 18000', topic: '财务', kind: 'fact', source: 'user_filled', config })
    const files = await fs.readdir(layout(tmp).claims)
    assert.equal(files.filter((f) => f.endsWith('.md')).length, 2)
    assert.ok(files.includes('index.yaml'))
    const idx = await fs.readFile(layout(tmp).claimIndex, 'utf8')
    assert.ok(idx.includes('职业去留'))
  })

  test('kind / source 非法值被拒绝', async () => {
    await assert.rejects(
      () => addClaim({ claim: 'x', topic: 't', kind: '瞎猜', config }),
      /kind 必须是/,
    )
    await assert.rejects(
      () => addClaim({ claim: 'x', topic: 't', source: '道听途说', config }),
      /source 必须是/,
    )
  })

  test('缺 claim 或 topic 被拒绝', async () => {
    await assert.rejects(() => addClaim({ claim: '', topic: 't', config }), /必填/)
    await assert.rejects(() => addClaim({ claim: 'x', config }), /必填/)
  })

  test('按主题/关键词/状态检索', async () => {
    await addClaim({ claim: '存款 12 万', topic: '财务', config })
    await addClaim({ claim: '想跳槽', topic: '职业去留', config })
    assert.equal((await queryClaims({ topic: '财务', config })).length, 1)
    assert.equal((await queryClaims({ text: '跳槽', config })).length, 1)
    assert.equal((await queryClaims({ status: 'all', config })).length, 2)
  })

  test('index.yaml 可安全删除后重建', async () => {
    await addClaim({ claim: 'a', topic: 't', config })
    await fs.rm(layout(tmp).claimIndex)
    const rows = await rebuildClaimIndex(tmp)
    assert.equal(rows.length, 1)
  })
})

// ─────────────────────────────────────────────────────────────

describe('L4 溯源链（核心不变式）', () => {
  test('能回到真实文件与真实行号，且内容对得上', async () => {
    const text = ['第一行：项目上线很有成就感', '第二行：我真的很喜欢这里', '第三行：绝对不会考虑离开'].join('\n')
    const { file } = await recordRaw({ text, topic: '职业', config })

    // 找到"绝对不会考虑离开"所在行
    const saved = await fs.readFile(path.join(tmp, file), 'utf8')
    const lineNo = saved.split('\n').findIndex((l) => l.includes('绝对不会考虑离开')) + 1
    assert.ok(lineNo > 0)

    const claim = await addClaim({
      claim: '2025-11 表示不会离开',
      topic: '职业去留',
      provenance: `${file}#L${lineNo}`,
      excerpt: '绝对不会考虑离开',
      config,
    })
    const t = await traceClaim({ id: claim.id, config })
    assert.equal(t.traced, true)
    assert.equal(t.file, file)
    assert.ok(t.lines.length >= 1)
    assert.ok(t.lines[0].text.includes('绝对不会考虑离开'), '溯源内容必须与原文一致')
    assert.equal(t.lines[0].line, lineNo, '行号必须真实')
  })

  test('没有 provenance 时明确报告无法溯源（而不是假装成功）', async () => {
    const c = await addClaim({ claim: '凭空的一句话', topic: 't', config })
    const t = await traceClaim({ id: c.id, config })
    assert.equal(t.traced, false)
    assert.match(t.reason, /没有记录来源指针/)
  })

  test('来源文件被删除时如实报告', async () => {
    const { file } = await recordRaw({ text: 'x', topic: 't', config })
    await fs.rm(path.join(tmp, file))
    const c = await addClaim({ claim: 'y', topic: 't', provenance: `${file}#L1`, config })
    const t = await traceClaim({ id: c.id, config })
    assert.equal(t.traced, false)
    assert.match(t.reason, /来源文件不存在/)
  })

  test('pad 能扩展上下文窗口', async () => {
    const { file } = await recordRaw({ text: 'A\nB\nC\nD\nE', topic: 't', config })
    const saved = await fs.readFile(path.join(tmp, file), 'utf8')
    const lineNo = saved.split('\n').findIndex((l) => l === 'C') + 1
    const c = await addClaim({ claim: 'c', topic: 't', provenance: `${file}#L${lineNo}`, config })
    const t = await traceClaim({ id: c.id, pad: 1, config })
    const texts = t.lines.map((l) => l.text)
    assert.ok(texts.includes('B') && texts.includes('C') && texts.includes('D'))
  })
})

// ─────────────────────────────────────────────────────────────

describe('旧前提作废', () => {
  test('作废必须给出理由', async () => {
    const c = await addClaim({ claim: '财务压力大', topic: '财务', config })
    await assert.rejects(() => supersedeClaim({ id: c.id, config }), /reason 必填/)
  })

  test('作废后状态变更并保留作废记录', async () => {
    const c = await addClaim({ claim: '财务压力大', topic: '财务', config })
    await supersedeClaim({ id: c.id, reason: '最新数据显示结余已改善', config })
    const [updated] = await queryClaims({ status: 'all', config })
    assert.equal(updated.status, 'disputed')
    assert.equal(updated.retire_reason, '最新数据显示结余已改善')
  })

  test('指定取代者时状态为 superseded', async () => {
    const old = await addClaim({ claim: '存款 5 万', topic: '财务', config })
    const neu = await addClaim({ claim: '存款 12 万', topic: '财务', config })
    await supersedeClaim({ id: old.id, reason: '更新', supersededBy: neu.id, config })
    const found = (await queryClaims({ status: 'all', config })).find((c) => c.id === old.id)
    assert.equal(found.status, 'superseded')
    assert.equal(found.superseded_by, neu.id)
  })

  test('作废不存在的 id 会报错', async () => {
    await assert.rejects(() => supersedeClaim({ id: 'nope', reason: 'x', config }), /找不到/)
  })
})

// ─────────────────────────────────────────────────────────────

describe('L3 档案与时效引擎', () => {
  test('字段写入带 source 与 updated_at', async () => {
    await setProfileField({ field: '存款', value: 120000, ttlDays: 90, config })
    const p = await readProfile({ config })
    assert.equal(p['存款'].value, 120000)
    assert.equal(p['存款'].ttl_days, 90)
    assert.equal(p['存款'].source, 'user_filled')
    assert.match(p['存款'].updated_at, /^\d{4}-\d{2}-\d{2}$/)
  })

  test('更新字段保留其它字段', async () => {
    await setProfileField({ field: 'A', value: 1, config })
    await setProfileField({ field: 'B', value: 2, config })
    const p = await readProfile({ config })
    assert.equal(p.A.value, 1)
    assert.equal(p.B.value, 2)
  })

  test('TTL 推断：学历不过期，存款 90 天，房租 180 天', () => {
    assert.equal(inferTtlDays('学历'), null)
    assert.equal(inferTtlDays('存款'), 90)
    assert.equal(inferTtlDays('房租'), 180)
    assert.equal(inferTtlDays('信用卡分期'), 90)
    assert.equal(inferTtlDays('价值观底线'), null)
    assert.equal(inferTtlDays('房贷'), 365)
  })

  test('fieldFreshness 五态判定（含 unset 与 unknown）', () => {
    const now = new Date('2026-09-17T00:00:00Z')
    assert.equal(fieldFreshness({ value: 1, updated_at: '2026-09-01', ttl_days: 90 }, now).state, 'fresh')
    assert.equal(fieldFreshness({ value: 1, updated_at: '2026-06-01', ttl_days: 90 }, now).state, 'stale')
    assert.equal(fieldFreshness({ value: 1, updated_at: '2026-07-01', ttl_days: 90 }, now).state, 'expiring')
    assert.equal(fieldFreshness({ value: '本科', updated_at: '2020-01-01', ttl_days: null }, now).state, 'no-expiry')
    // 从未填过值：与"过期"不同，要请用户首次填写
    assert.equal(fieldFreshness({ ttl_days: 90 }, now).state, 'unset')
    assert.equal(fieldFreshness({ value: null, ttl_days: 90 }, now).state, 'unset')
    // 有值但没有 updated_at（无法判断年龄）
    assert.equal(fieldFreshness({ value: 1, ttl_days: 90 }, now).state, 'unknown')
  })

  test('依赖图递归展开并处理成环', async () => {
    await setProfileField({ field: '跳槽决策', value: '未定', dependsOn: ['存款', '月收入'], config })
    await setProfileField({ field: '存款', value: 1, ttlDays: 90, config })
    await setProfileField({ field: '月收入', value: 2, ttlDays: 180, config })
    const p = await readProfile({ config })
    const deps = resolveDependencies(p, '跳槽决策')
    assert.deepEqual(deps.sort(), ['存款', '月收入', '跳槽决策'].sort())

    // 成环不应死循环
    await setProfileField({ field: 'X', value: 1, dependsOn: ['Y'], config })
    await setProfileField({ field: 'Y', value: 1, dependsOn: ['X'], config })
    const p2 = await readProfile({ config })
    assert.deepEqual(resolveDependencies(p2, 'X').sort(), ['X', 'Y'].sort())
  })

  test('checkStaleness 只报出该决策真正依赖的过时字段', async () => {
    await setProfileField({ field: '现职满意度', value: '低', ttlDays: null, config })
    await setProfileField({ field: '存款', value: 120000, ttlDays: 90, config })
    await setProfileField({ field: '月收入', value: 18000, ttlDays: 180, config })
    await setProfileField({ field: '跳槽决策', value: '未定', dependsOn: ['现职满意度'], config })

    // 人为把存款改为很久以前
    const p = await readProfile({ config })
    p['存款'].updated_at = '2025-01-01'
    await fs.writeFile(layout(tmp).profile, `fields:\n${Object.entries(p).map(([k, v]) => `  ${k}:\n${Object.entries(v).map(([kk, vv]) => `    ${kk}: ${JSON.stringify(vv)}`).join('\n')}`).join('\n')}\n`)

    const p2 = await readProfile({ config })
    // 跳槽决策只依赖「现职满意度」，所以不该把过时的存款算作阻塞
    const r = checkStaleness({ fields: p2, decision: '跳槽决策' })
    assert.equal(r.blocking.length, 0)
    assert.deepEqual(r.checked, ['跳槽决策', '现职满意度'])
  })

  test('未指定决策时检查全部字段', async () => {
    await setProfileField({ field: '存款', value: 1, ttlDays: 90, config })
    const p = await readProfile({ config })
    p['存款'].updated_at = '2020-01-01'
    const r = checkStaleness({ fields: p })
    assert.equal(r.blocking.length, 1)
    assert.equal(r.blocking[0].field, '存款')
  })

  test('isEmptyValue：空值算空，但 0 与 false 是有效值', () => {
    assert.ok(isEmptyValue(null))
    assert.ok(isEmptyValue(undefined))
    assert.ok(isEmptyValue('   '))
    assert.ok(isEmptyValue([]))
    // 这两个是关键：0 元和 false 都是有意义的事实，不能当空
    assert.ok(!isEmptyValue(0))
    assert.ok(!isEmptyValue(false))
    assert.ok(!isEmptyValue('0'))
  })

  test('从未填过值的字段被识别为 unset（与 stale 分开报）', async () => {
    await setProfileField({ field: '存款', value: null, ttlDays: 90, config })
    await setProfileField({ field: '现职满意度', value: '低', config })
    const p = await readProfile({ config })

    const r = checkStaleness({ fields: p })
    assert.equal(r.unset.length, 1, '空值字段应进 unset')
    assert.equal(r.unset[0].field, '存款')
    assert.equal(r.blocking.length, 0, '空值不该被混进 stale')
  })

  test('unset 提示要请用户首次填写，并给「跳过」的出路', async () => {
    await setProfileField({ field: '现有存款', value: null, config })
    const p = await readProfile({ config })
    const r = checkStaleness({ fields: p })
    const text = renderStalenessPrompt(r, '跳槽决策')
    assert.ok(text.includes('从来没有填过'), '应说明是从未填写')
    assert.ok(text.includes('空白'), '应点明这是空白而非过时')
    assert.ok(text.includes('现在补上'))
    assert.ok(text.includes('暂时跳过'), '必须给跳过的出路，否则会卡住用户')
  })

  test('unset 与 stale 同时存在时都要报出来', async () => {
    await setProfileField({ field: '存款', value: null, ttlDays: 90, config })
    await setProfileField({ field: '月收入', value: 18000, ttlDays: 180, config })
    const p = await readProfile({ config })
    p['月收入'].updated_at = '2020-01-01'   // 人为做旧
    const r = checkStaleness({ fields: p })
    assert.equal(r.unset.length, 1)
    assert.equal(r.blocking.length, 1)
    const text = renderStalenessPrompt(r, 'X')
    assert.ok(text.includes('从来没有填过'))
    assert.ok(text.includes('可能已经不准'))
  })

  test('提示文案必须给出「沿用旧值」选项（否则用户会被卡住）', async () => {
    await setProfileField({ field: '存款', value: 120000, ttlDays: 90, config })
    const p = await readProfile({ config })
    p['存款'].updated_at = '2020-01-01'
    const r = checkStaleness({ fields: p })
    const text = renderStalenessPrompt(r, '是否跳槽')
    assert.ok(text.includes('现在更新'))
    assert.ok(text.includes('沿用旧值'))
    assert.ok(text.includes('是否跳槽'))
  })

  test('无需提示时返回 null', () => {
    assert.equal(renderStalenessPrompt({ blocking: [], expiring: [] }), null)
  })
})

// ─────────────────────────────────────────────────────────────

describe('反证引擎', () => {
  test('极性识别（本模块约定：+ = 留下倾向，- = 离开倾向）', () => {
    assert.deepEqual(polarityOf('我想跳槽').find((h) => h.axis === '去留'), { axis: '去留', sign: '-' })
    assert.deepEqual(polarityOf('绝对不会考虑离开').find((h) => h.axis === '去留'), { axis: '去留', sign: '+' })
    assert.deepEqual(polarityOf('挺喜欢这里，但真的受不了这个管理方式').find((h) => h.axis === '去留'), { axis: '去留', sign: '±' })
  })

  test('「不想走」这类否定式必须判为正向（不得被子串「想走」误伤）', () => {
    assert.deepEqual(polarityOf('我不想走').find((h) => h.axis === '去留'), { axis: '去留', sign: '+' })
    assert.deepEqual(polarityOf('不打算离开').find((h) => h.axis === '去留'), { axis: '去留', sign: '+' })
    assert.deepEqual(polarityOf('不想离职').find((h) => h.axis === '去留'), { axis: '去留', sign: '+' })
  })

  test('同一句内含转折时给出 ± （它自己就是待追问对象）', () => {
    const hits = polarityOf('我挺喜欢这里，但真的受不了这个管理方式')
    assert.deepEqual(hits.find((h) => h.axis === '去留'), { axis: '去留', sign: '±' })
  })

  test('跨时点的相反表述被识别为张力', async () => {
    const a = await addClaim({
      claim: '我很喜欢这里，绝对不会考虑离开',
      topic: '职业去留',
      occurredAt: '2025-11-03',
      context: '刚完成一个项目',
      config,
    })
    const b = await addClaim({
      claim: '受不了这个管理方式，开始认真考虑跳槽',
      topic: '职业去留',
      occurredAt: '2026-01-18',
      context: '连续加班三周',
      config,
    })
    const tensions = findTensions([a, b])
    // 这两句在「去留」和「满意度」两个轴上都方向相反，各自都是一条独立张力
    assert.equal(tensions.length, 2)
    // 不依赖 sort 的排序实现（码点序与 locale 序结果不同），直接断言集合内容
    assert.deepEqual(
      new Set(tensions.map((t) => t.axis)),
      new Set(['满意度', '去留']),
    )
    const 去留 = tensions.find((t) => t.axis === '去留')
    assert.equal(去留.statements.length, 2)
    assert.deepEqual(去留.statements.map((s) => s.occurred_at), ['2025-11-03', '2026-01-18'])
    assert.deepEqual(去留.statements.map((s) => s.sign), ['+', '-'])  // 先留下倾向，后离开倾向
  })

  test('同一天内的相反表述不算张力（多半是语境差异）', async () => {
    const a = await addClaim({ claim: '想跳槽', topic: 't', occurredAt: '2026-01-01', config })
    const b = await addClaim({ claim: '不想走', topic: 't', occurredAt: '2026-01-01', config })
    assert.equal(findTensions([a, b]).length, 0)
  })

  test('还原文案：含时间、语境、并【以提问收尾】', async () => {
    const a = await addClaim({ claim: '我很喜欢这里，绝对不会考虑离开', topic: '职业去留', occurredAt: '2025-11-03', context: '刚完成项目', config })
    const b = await addClaim({ claim: '想跳槽', topic: '职业去留', occurredAt: '2026-01-18', context: '连续加班', config })
    const text = renderRestoration({ topic: '职业去留', tension: findTensions([a, b])[0] })
    assert.ok(text.includes('2025-11-03') && text.includes('2026-01-18'))
    assert.ok(text.includes('刚完成项目') && text.includes('连续加班'))
    assert.ok(text.includes('？'), '必须以提问收尾')
    assert.ok(/未必互相矛盾|本来就可以并存/.test(text), '必须给出"两句可同时为真"的解释路径')
  })

  test('还原文案不得使用指控性措辞', async () => {
    const a = await addClaim({ claim: '不想走', topic: 't', occurredAt: '2025-01-01', config })
    const b = await addClaim({ claim: '想跳槽', topic: 't', occurredAt: '2026-01-01', config })
    const text = renderRestoration({ topic: 't', tension: findTensions([a, b])[0] })
    for (const forbidden of ['你矛盾', '自相矛盾', '不一致', '你说谎', '错了吧']) {
      assert.ok(!text.includes(forbidden), `不应出现指控性措辞：${forbidden}`)
    }
  })

  test('buildCounterEvidence 汇总张力与旧前提', async () => {
    await addClaim({ claim: '我很喜欢这里，绝对不会考虑离开', topic: '职业去留', occurredAt: '2025-11-03', config })
    await addClaim({ claim: '想跳槽', topic: '职业去留', occurredAt: '2026-01-18', config })
    const c = await addClaim({ claim: '财务压力大，不敢动', topic: '财务', occurredAt: '2025-06-01', config })
    await supersedeClaim({ id: c.id, reason: '结余已改善', config })

    const all = await queryClaims({ status: 'all', config })
    const r = buildCounterEvidence({ claims: all })
    assert.ok(r.findings.length >= 1)
    assert.ok(r.staleOut.includes('结余已改善'))
  })

  test('同一组表述在多个轴上相反时，表格只渲染一次', async () => {
    // "喜欢这里" 与 "受不了管理方式" 同时命中「去留」与「满意度」
    await addClaim({ claim: '我很喜欢这里，绝对不会考虑离开', topic: '职业去留', occurredAt: '2025-11-03', config })
    await addClaim({ claim: '受不了这个管理方式，开始认真考虑跳槽', topic: '职业去留', occurredAt: '2026-01-18', config })
    const all = await queryClaims({ status: 'all', config })
    const r = buildCounterEvidence({ claims: all })
    assert.equal(r.findings.length, 1, '同一组表述应合并为一条 finding，而不是每个轴一条')
    assert.ok(r.findings[0].axes.length >= 2, '应记录它命中的多个轴')
    // 表格只出现一次
    const tableCount = (r.findings[0].rendered.match(/\| 时间 \| 表述 \| 当时的语境 \|/g) ?? []).length
    assert.equal(tableCount, 1, '表格不得重复渲染')
    assert.ok(r.findings[0].rendered.includes('其它维度上也方向相反'))
  })

  test('逐轴解释文案不得张冠李戴（满意度不能说"走不走"）', async () => {
    await addClaim({ claim: '我很喜欢这里，绝对不会考虑离开', topic: 't', occurredAt: '2025-11-03', config })
    await addClaim({ claim: '受不了这个管理方式，开始认真考虑跳槽', topic: 't', occurredAt: '2026-01-18', config })
    await addClaim({ claim: '挺好的，有成就感', topic: 't', occurredAt: '2025-01-01', config })
    const all = await queryClaims({ status: 'all', config })
    const clusters = clusterByTopic(all)
    for (const [, list] of clusters) {
      for (const tension of findTensions(list)) {
        const text = renderRestoration({ topic: 't', tension })
        if (tension.axis === '满意度') {
          assert.ok(!text.includes('走不走'), '满意度轴的文案不应谈走不走')
        }
        assert.ok(text.includes(tension.axis), `标题应标出轴名 ${tension.axis}`)
      }
    }
  })

  test('找不到反证时如实说明（不得暗示"没有反证"）', async () => {
    await addClaim({ claim: '存款 12 万', topic: '财务', config })
    const all = await queryClaims({ status: 'all', config })
    const r = buildCounterEvidence({ claims: all })
    assert.equal(r.findings.length, 0)
    assert.match(r.note, /不等于没有反证/)
  })
})

// ─────────────────────────────────────────────────────────────

describe('L4 溯源索引', () => {
  test('追加结论并保留 claim 引用', async () => {
    const { addConclusion } = await import('../src/lib/store.js')
    const c = await addClaim({ claim: 'x', topic: 't', config })
    await addConclusion({ statement: '空窗期可行', claimIds: [c.id], config })
    const idx = await readIndex({ config })
    assert.equal(idx.conclusions.length, 1)
    assert.equal(idx.conclusions[0].claim_ids[0], c.id)
  })
})
