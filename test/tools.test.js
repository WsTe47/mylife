/**
 * MyLife 工具层端到端测试。
 *
 * 跑：node --test test/tools.test.js
 *
 * 这里测的是**整条链**（不启动 harness）：
 *   record → digest → claim_add → trace → staleness → counter_evidence → status
 *
 * 重点验证"不谄媚"的设计是否真的成立：
 *   - 引不出出处的证据必须被明确标出
 *   - 给出正向结论前，反证工具能找出跨时点的相反表述
 *   - 过时字段必须被发现，且提示里含"沿用"选项
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { execute, buildStatus } from '../src/tools/execute.js'
import { createTools } from '../src/tools/index.js'

let tmp
let cfg

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-tools-'))
  cfg = { workspaceRoot: tmp }
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('工具清单', () => {
  test('工具定义形状合法（name/description/parameters/output）', () => {
    const tools = createTools(cfg)
    assert.ok(tools.length >= 10)
    for (const t of tools) {
      assert.equal(typeof t.name, 'string')
      assert.ok(t.name.startsWith('mylife_'), `${t.name} 应有 mylife_ 前缀`)
      assert.equal(typeof t.description, 'string')
      assert.ok(t.description.length > 20, `${t.name} 的描述过短`)
      assert.equal(t.parameters.type, 'object')
      assert.equal(typeof t.output.render, 'function')
      assert.ok(t.output.schema, `${t.name} 缺少 output.schema`)
    }
  })

  test('工具名唯一', () => {
    const names = createTools(cfg).map((t) => t.name)
    assert.equal(new Set(names).size, names.length)
  })

  test('不使用保留名 run_code', () => {
    assert.ok(!createTools(cfg).some((t) => t.name === 'run_code'))
  })

  test('参数 schema 只用连写 JSON Schema 支持的子集（无联合类型）', () => {
    for (const t of createTools(cfg)) {
      for (const [key, spec] of Object.entries(t.parameters.properties ?? {})) {
        if (spec.type !== undefined) {
          assert.equal(
            typeof spec.type,
            'string',
            `${t.name}.${key} 的 type 必须是字符串（不支持 type 数组）`,
          )
        }
      }
    }
  })

  test('每个工具的 render 都能吃下它的规范输出而不抛错', () => {
    for (const t of createTools(cfg)) {
      assert.doesNotThrow(() => t.output.render({}, {}), `${t.name}.render 抛错了`)
    }
  })
})

describe('核心链路 record → digest → claim_add → trace', () => {
  test('整条链能跑通，且溯源内容与原文逐字一致', async () => {
    // 1. 记录原始输入（含错别字）
    const rec = await execute('mylife_record', {
      text: '今天项目上线很有成就感，团队的人都很好，我真的很喜欢这里。\n我觉得短期内绝对不会考虑离开。',
      topic: '职业',
      source: 'voice',
    }, cfg)
    assert.ok(rec.file.startsWith('raw/'))

    // 2. 找到真实行号
    const abs = path.join(tmp, rec.file)
    const lines = (await fs.readFile(abs, 'utf8')).split('\n')
    const lineNo = lines.findIndex((l) => l.includes('绝对不会考虑离开')) + 1
    assert.ok(lineNo > 0)

    // 3. 写摘要（保留 AI 原稿与用户修订版）
    const dig = await execute('mylife_digest', {
      topic: '职业去留',
      ai_draft: '用户似乎对现状满意',
      revised: '我认可工作内容和同事，但当时没意识到强度问题',
      provenance: [`${rec.file}#L${lineNo}`],
    }, cfg)
    assert.equal(dig.revisions, 1)
    assert.equal(dig.divergent, true)

    // 4. 加证据，带真实出处
    const claim = await execute('mylife_claim_add', {
      claim: '2025-11 表示不会离开',
      topic: '职业去留',
      kind: 'assessment',
      source: 'user_raw',
      provenance: `${rec.file}#L${lineNo}`,
      excerpt: '绝对不会考虑离开',
      context: '刚完成一个项目',
      occurred_at: '2025-11-03',
    }, cfg)
    assert.match(claim.id, /^\d{4}-\d{2}-\d{2}-\d{3}$/)

    // 5. 溯源
    const traced = await execute('mylife_trace', { id: claim.id }, cfg)
    assert.equal(traced.traced, true)
    assert.equal(traced.file, rec.file)
    assert.ok(traced.lines[0].text.includes('绝对不会考虑离开'))
    assert.equal(traced.lines[0].line, lineNo, '行号必须与写入时一致')
  })

  test('用 record 返回的 provenance 建证据，trace 必须取到原文（端到端）', async () => {
    const rec = await execute('mylife_record', {
      text: '我今天很迷茫，不知道要不要换城市。',
      topic: '验证',
    }, cfg)

    // 直接把工具返回的 provenance 拿去用 —— 这是 agent 应该做的
    const claim = await execute('mylife_claim_add', {
      claim: '验证：用户在考虑换城市',
      topic: '验证',
      kind: 'assessment',
      source: 'user_raw',
      provenance: rec.provenance,
      excerpt: '不知道要不要换城市',
    }, cfg)

    const traced = await execute('mylife_trace', { id: claim.id }, cfg)
    assert.equal(traced.traced, true)
    const joined = traced.lines.map((l) => l.text).join('\n')
    assert.ok(joined.includes('不知道要不要换城市'), '溯源必须取到原文内容')
    // 不得取到元信息头或空行
    assert.ok(!joined.includes('原始层：一字不改'), '不得指到元信息头')
    assert.ok(joined.trim() !== '', '不得指到空行')
  })

  test('render 会把 provenance 明示给 agent（避免它猜行号）', async () => {
    const rec = await execute('mylife_record', { text: 'x', topic: 't' }, cfg)
    const rendered = createTools(cfg)
      .find((t) => t.name === 'mylife_record')
      .output.render({}, rec)[0].text
    assert.ok(rendered.includes(rec.provenance), '应直接给出可用的 provenance')
    assert.ok(rendered.includes(String(rec.startLine)), '应给出正文起始行')
    assert.ok(rendered.includes('不要自己猜行号') || rendered.includes('元信息头'))
  })

  test('无出处的证据在简报里被明确标出', async () => {
    await execute('mylife_claim_add', {
      claim: '一条没有出处的断言',
      topic: 't',
      kind: 'inference',
      source: 'llm_inferred',
    }, cfg)
    const status = await buildStatus(cfg)
    assert.equal(status.unsourcedClaims.length, 1)
  })
})

describe('反证链：跨时点的相反表述', () => {
  test('能找出并把两段表述连同语境一起呈现', async () => {
    await execute('mylife_claim_add', {
      claim: '我很喜欢这里，绝对不会考虑离开',
      topic: '职业去留',
      occurred_at: '2025-11-03',
      context: '刚完成一个项目',
      excerpt: '绝对不会考虑离开',
    }, cfg)
    await execute('mylife_claim_add', {
      claim: '受不了这个管理方式，开始认真考虑跳槽',
      topic: '职业去留',
      occurred_at: '2026-01-18',
      context: '连续加班三周',
      excerpt: '开始认真考虑跳槽',
    }, cfg)

    const ce = await execute('mylife_counter_evidence', { topic: '职业去留' }, cfg)
    assert.ok(ce.findings.length >= 1)

    const 去留 = ce.findings.find((f) => f.tension.axis === '去留')
    assert.ok(去留, '应识别出去留轴上的张力')

    // 渲染出的文案必须含时间、语境、并以提问收尾
    assert.ok(去留.rendered.includes('2025-11-03'))
    assert.ok(去留.rendered.includes('2026-01-18'))
    assert.ok(去留.rendered.includes('刚完成一个项目'))
    assert.ok(去留.rendered.includes('连续加班三周'))
    assert.ok(去留.rendered.includes('？'), '必须以提问收尾')
    // 不得是指控口吻
    assert.ok(!/你矛盾|自相矛盾/.test(去留.rendered))
  })

  test('用户的"沿用旧值"路径：作废后简报能反映出来', async () => {
    const c = await execute('mylife_claim_add', {
      claim: '财务压力大，不敢动',
      topic: '财务',
      occurred_at: '2025-06-01',
    }, cfg)

    const ce1 = await execute('mylife_counter_evidence', {}, cfg)
    assert.ok(ce1.staleOut?.includes('财务压力大'), '未作废时应出现在"可能还在沿用的旧约束"里')

    await execute('mylife_supersede', {
      id: c.id,
      reason: '用户确认：按最新数据结余已改善，该约束不再成立',
    }, cfg)

    const ce2 = await execute('mylife_counter_evidence', {}, cfg)
    assert.ok(ce2.staleOut?.includes('结余已改善'), '作废后应出现在"已作废的前提"里')

    const status = await buildStatus(cfg)
    assert.equal(status.claims.disputed, 1)
  })
})

describe('时效链：依赖图 → 阻塞字段 → 提示文案', () => {
  test('决策只检查它真正依赖的字段', async () => {
    await execute('mylife_profile_set', { field: '存款', value: 120000, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', { field: '现职满意度', value: '低' }, cfg)
    await execute('mylife_profile_set', {
      field: '跳槽决策',
      value: '未定',
      depends_on: ['现职满意度'],
    }, cfg)

    // 把存款改成很久以前
    const profileFile = path.join(tmp, 'profile.yaml')
    let text = await fs.readFile(profileFile, 'utf8')
    text = text.replace(/存款:[\s\S]*?updated_at: ["'][^"']*["']/, (m) =>
      m.replace(/updated_at: ["'][^"']*["']/, 'updated_at: "2020-01-01"'))
    await fs.writeFile(profileFile, text)

    const r = await execute('mylife_staleness_check', { decision: '跳槽决策' }, cfg)
    assert.deepEqual(r.checked, ['跳槽决策', '现职满意度'])
    assert.equal(r.blocking.length, 0, '存款过时但不被该决策依赖，不应阻塞')
  })

  test('被依赖的过期字段会阻塞，且提示含"沿用旧值"', async () => {
    await execute('mylife_profile_set', { field: '存款', value: 120000, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', {
      field: '裸辞决策',
      value: '未定',
      depends_on: ['存款'],
    }, cfg)

    const profileFile = path.join(tmp, 'profile.yaml')
    let text = await fs.readFile(profileFile, 'utf8')
    text = text.replace(/存款:([\s\S]*?)updated_at: ["'][^"']*["']/, (m, g1) =>
      `存款:${g1}updated_at: "2020-01-01"`)
    await fs.writeFile(profileFile, text)

    const r = await execute('mylife_staleness_check', { decision: '裸辞决策' }, cfg)
    assert.equal(r.blocking.length, 1)
    assert.equal(r.blocking[0].field, '存款')

    const tools = createTools(cfg)
    const rendered = tools
      .find((t) => t.name === 'mylife_staleness_check')
      .output.render({}, r)[0].text
    assert.ok(rendered.includes('现在更新'))
    assert.ok(rendered.includes('沿用旧值'), '必须给出沿用的出路，否则用户会被卡住')
  })

  test('profile_set 自动推断 TTL 并登记字段词典', async () => {
    const r = await execute('mylife_profile_set', { field: '存款', value: 120000 }, cfg)
    assert.equal(r.ttl_days, 90)
    const dict = await fs.readFile(path.join(tmp, 'fields.yaml'), 'utf8')
    assert.ok(dict.includes('存款'))
    assert.ok(dict.includes('ttl_source: inferred'))
  })

  test('学历类字段自动判为不过期', async () => {
    const r = await execute('mylife_profile_set', { field: '学历', value: '普通本科' }, cfg)
    assert.equal(r.ttl_days, null)
  })
})

describe('结论溯源（反谄媚的结构保证）', () => {
  test('有依据的结论被登记，无依据的会被标记', async () => {
    const c = await execute('mylife_claim_add', { claim: 'x', topic: 't' }, cfg)

    const withEvidence = await execute('mylife_conclusion_add', {
      statement: '空窗期可行',
      claim_ids: [c.id],
    }, cfg)
    assert.deepEqual(withEvidence.claim_ids, [c.id])

    const without = await execute('mylife_conclusion_add', { statement: '拍脑袋的判断' }, cfg)
    const rendered = createTools(cfg)
      .find((t) => t.name === 'mylife_conclusion_add')
      .output.render({}, without)[0].text
    assert.ok(rendered.includes('无依据'))
  })
})

describe('开场简报', () => {
  test('空档案时明确说明"不要假装了解用户"', async () => {
    const s = await buildStatus(cfg)
    assert.equal(s.hasAnything, false)
    const rendered = createTools(cfg)
      .find((t) => t.name === 'mylife_status')
      .output.render({}, s)[0].text
    assert.ok(rendered.includes('档案为空'))
    assert.ok(rendered.includes('不要假装了解用户'))
  })

  test('⚠️ 空白字段必须出现在简报里（曾经完全隐形）', async () => {
    // 回归守卫：这是真实缺陷 —— status 只过滤 stale/expiring，
    // 于是 value:null 的占位字段在简报里看不见，agent 会以为数据齐全。
    await execute('mylife_profile_set', { field: '现有存款', value: null }, cfg)
    await execute('mylife_profile_set', { field: '月税后收入', value: null }, cfg)

    const s = await buildStatus(cfg)
    assert.ok(s.fields.unset, 'status 必须给出 unset 列表')
    assert.equal(s.fields.unset.length, 2)

    const text = createTools(cfg)
      .find((t) => t.name === 'mylife_status')
      .output.render({}, s)[0].text
    assert.ok(text.includes('现有存款'), '空字段必须被点名')
    assert.ok(text.includes('月税后收入'))
    assert.ok(text.includes('从未填写'), '必须说清这是空白而非正常')
    assert.ok(text.includes('不是"没问题"'), '不得让空白看起来像没事')
  })

  test('决策卡在空白上时必须报出，并指示 agent 先问用户', async () => {
    await execute('mylife_profile_set', { field: '现有存款', value: null, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', {
      field: '裸辞决策', value: '未定', ttl_days: null, depends_on: ['现有存款'],
    }, cfg)

    const s = await buildStatus(cfg)
    assert.equal(s.blockedDecisions.length, 1)
    assert.equal(s.blockedDecisions[0].field, '裸辞决策')
    assert.deepEqual(s.blockedDecisions[0].unset, ['现有存款'])
    assert.equal(s.blockedDecisions[0].decidable, false)

    const text = createTools(cfg)
      .find((t) => t.name === 'mylife_status')
      .output.render({}, s)[0].text
    assert.ok(text.includes('卡在空白上'))
    assert.ok(text.includes('先把上面缺的字段问出来'), '必须给出下一步指令')
    assert.ok(text.includes('暂时跳过'), '必须保留跳过出路，禁止替用户假设')
  })

  test('依赖齐全的决策不算卡住', async () => {
    await execute('mylife_profile_set', { field: '存款', value: 120000, ttl_days: 90 }, cfg)
    await execute('mylife_profile_set', {
      field: 'D', value: '未定', ttl_days: null, depends_on: ['存款'],
    }, cfg)
    const s = await buildStatus(cfg)
    const d = s.blockedDecisions.find((x) => x.field === 'D')
    assert.equal(d, undefined, '依赖齐全的决策不该出现在受阻列表')
  })

  test('有内容时汇总字段、主题与过期项', async () => {
    await execute('mylife_profile_set', { field: '月收入', value: 18000, ttl_days: 180 }, cfg)
    await execute('mylife_claim_add', { claim: 'a', topic: '职业去留' }, cfg)
    await execute('mylife_claim_add', { claim: 'b', topic: '财务' }, cfg)

    const s = await buildStatus(cfg)
    assert.equal(s.hasAnything, true)
    assert.equal(s.fields.total, 1)
    assert.equal(s.claims.active, 2)
    // 不依赖 locale 排序结果，直接断言集合
    assert.deepEqual(new Set(s.claims.topics), new Set(['财务', '职业去留']))

    const rendered = createTools(cfg)
      .find((t) => t.name === 'mylife_status')
      .output.render({}, s)[0].text
    assert.ok(rendered.includes('我现在的状态'))
    assert.ok(rendered.includes('职业去留'))
  })
})

describe('错误处理', () => {
  test('未知工具报错', async () => {
    await assert.rejects(() => execute('mylife_nope', {}, cfg), /未知工具/)
  })

  test('缺必填参数时抛出可读错误', async () => {
    await assert.rejects(() => execute('mylife_record', {}, cfg), /text 不能为空/)
    await assert.rejects(() => execute('mylife_claim_add', { claim: 'x' }, cfg), /必填/)
    await assert.rejects(() => execute('mylife_trace', { id: 'nope' }, cfg), /找不到/)
  })

  test('非法的 kind/source 被拒绝', async () => {
    await assert.rejects(
      () => execute('mylife_claim_add', { claim: 'x', topic: 't', kind: 'bad' }, cfg),
      /kind 必须是/,
    )
  })
})
