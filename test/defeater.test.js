/**
 * 证伪链测试。
 *
 * 全部用 **stub llm** —— 逻辑正确性不该依赖真实 API，也不该每次跑测试都烧钱。
 * 真实 API 的冒烟测试单独放在文件末尾，默认跳过（设 MYLIFE_LIVE_LLM=1 启用）。
 *
 * 跑：node --test test/defeater.test.js
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDefeaterAnalysis,
  extractJson,
  generateDefeaters,
  renderDefeaterReport,
  renderFacts,
  searchDefeaters,
} from '../src/lib/defeater.js'
import { readKeyFromDshCredentials, resolveLlmConfig } from '../src/lib/llm.js'
import { execute } from '../src/tools/execute.js'
import { createTools } from '../src/tools/index.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 造一个按脚本回答的 stub llm。 */
function stubLlm(script) {
  let i = 0
  const calls = []
  const fn = async (messages, opts) => {
    calls.push({ messages, opts })
    const step = script[i++]
    if (typeof step === 'function') return step(messages, opts)
    if (step === undefined) throw new Error(`stub 收到多余的调用（第 ${i} 次）`)
    return step
  }
  fn.calls = calls
  return fn
}

const GEN_OK = JSON.stringify({
  defeaters: [
    {
      proposition: '领导给的认可足以弥补其他不满',
      type: 'gap',
      why_it_defeats: '若认可足够，离开就不是最优解',
      evidence_needed: '领导认可在整体满意度中的权重',
    },
    {
      proposition: '感谢领导 vs 决定离开',
      type: 'internal',
      why_it_defeats: '若亏欠感是真实约束，离开的成本被低估',
      evidence_needed: '这两句是否指向同一件事',
      tension_between: '对领导的感激 / 离开的决定',
    },
  ],
})

describe('extractJson', () => {
  test('纯 JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  })
  test('包在 ```json 代码块里', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  })
  test('前后带解释文字', () => {
    assert.deepEqual(extractJson('好的，结果如下：{"a":1} 以上。'), { a: 1 })
  })
  test('无法解析时返回 null，而不是抛错', () => {
    assert.equal(extractJson('完全不是 JSON'), null)
    assert.equal(extractJson(null), null)
    assert.equal(extractJson(undefined), null)
  })
})

describe('generateDefeaters', () => {
  test('正常解析并规范化', async () => {
    const llm = stubLlm([GEN_OK])
    const ds = await generateDefeaters({ proposition: 'P', corpus: 'C', llm })
    assert.equal(ds.length, 2)
    assert.equal(ds[0].id, 'D1')
    assert.equal(ds[0].type, 'gap')
    assert.equal(ds[1].type, 'internal')
    assert.equal(ds[1].tension_between, '对领导的感激 / 离开的决定')
  })

  test('label 优先，缺失时自动截断兜底（标题必须短）', async () => {
    const long = '作者在文中提到自己依旧非常卷，这与该离开公司的结论存在张力，因为如果他能保持高投入'
    const llm = stubLlm([JSON.stringify({ defeaters: [
      { proposition: 'x', label: '领导认可足以留住他', type: 'gap' },
      { proposition: long, type: 'gap' },
    ] })])
    const ds = await generateDefeaters({ proposition: 'P', corpus: 'C', llm })
    assert.equal(ds[0].label, '领导认可足以留住他')
    assert.ok(ds[1].label.length <= 25, `兜底标题过长: ${ds[1].label.length}`)
    assert.ok(ds[1].label.endsWith('…'), '截断应有省略号')
  })

  test('渲染用短 label 做标题，长命题降为引用块', () => {
    const text = renderDefeaterReport({ proposition: 'P', results: [
      { id: 'D1', type: 'gap', label: '存款能撑几个月', proposition: '这是一个很长的完整命题，包含许多解释性文字，不应出现在标题位置',
        verdict: 'C', quotes: [], evidence_needed: '存款月数' },
    ] })
    assert.ok(text.includes('### D1｜存款能撑几个月'), '标题应为短 label')
    assert.ok(!text.includes('### D1｜这是一个很长的完整命题'), '长命题不应做标题')
  })

  test('缺 proposition 的条目被丢弃', async () => {
    const llm = stubLlm([JSON.stringify({
      defeaters: [{ proposition: '有效' }, { proposition: '' }, { type: 'gap' }, null],
    })])
    const ds = await generateDefeaters({ proposition: 'P', corpus: 'C', llm })
    assert.equal(ds.length, 1)
    assert.equal(ds[0].proposition, '有效')
  })

  test('非法 type 回退为 gap（不因为模型抖动丢掉整条）', async () => {
    const llm = stubLlm([JSON.stringify({ defeaters: [{ proposition: 'x', type: '瞎写' }] })])
    const ds = await generateDefeaters({ proposition: 'P', corpus: 'C', llm })
    assert.equal(ds[0].type, 'gap')
  })

  test('返回结构不对时给空数组，不抛错', async () => {
    const llm = stubLlm(['{"foo":"bar"}'])
    assert.deepEqual(await generateDefeaters({ proposition: 'P', corpus: 'C', llm }), [])
  })

  test('缺参数时抛可读错误', async () => {
    const llm = stubLlm([])
    await assert.rejects(() => generateDefeaters({ corpus: 'C', llm }), /proposition/)
    await assert.rejects(() => generateDefeaters({ proposition: 'P', llm }), /corpus/)
  })
})

describe('searchDefeaters', () => {
  const ds = [
    { id: 'D1', type: 'gap', proposition: 'a', evidence_needed: 'x' },
    { id: 'D2', type: 'internal', proposition: 'b', tension_between: 'y' },
    { id: 'D3', type: 'gap', proposition: 'c' },
  ]

  test('三态判定被正确解析', async () => {
    const llm = stubLlm([
      JSON.stringify({ verdict: 'A', quotes: ['原话1'], note: '有支持' }),
      JSON.stringify({ verdict: 'B', quotes: ['原话2'], note: '被否定' }),
      JSON.stringify({ verdict: 'C', quotes: [], note: '无证据' }),
    ])
    const out = await searchDefeaters({ defeaters: ds, corpus: 'C', llm })
    assert.deepEqual(out.map((r) => r.verdict), ['A', 'B', 'C'])
    assert.deepEqual(out[0].quotes, ['原话1'])
  })

  test('contradiction_pair 只有长度为 2 时才接受', async () => {
    const llm = stubLlm([
      JSON.stringify({ verdict: 'A', contradiction_pair: ['一', '二'] }),
      JSON.stringify({ verdict: 'A', contradiction_pair: ['只有一个'] }),
      JSON.stringify({ verdict: 'A', contradiction_pair: null }),
    ])
    const out = await searchDefeaters({ defeaters: ds, corpus: 'C', llm })
    assert.deepEqual(out[0].contradiction_pair, ['一', '二'])
    assert.equal(out[1].contradiction_pair, null)
    assert.equal(out[2].contradiction_pair, null)
  })

  test('单条失败不影响其余（标为 ? 并记原因）', async () => {
    const llm = stubLlm([
      JSON.stringify({ verdict: 'A' }),
      () => { throw new Error('网络抖了') },
      JSON.stringify({ verdict: 'C' }),
    ])
    const out = await searchDefeaters({ defeaters: ds, corpus: 'C', llm })
    assert.deepEqual(out.map((r) => r.verdict), ['A', '?', 'C'])
    assert.match(out[1].note, /网络抖了/)
  })

  test('非法 verdict 回退为 C', async () => {
    const llm = stubLlm([JSON.stringify({ verdict: 'Z' })])
    const out = await searchDefeaters({ defeaters: [ds[0]], corpus: 'C', llm })
    assert.equal(out[0].verdict, 'C')
  })
})

describe('buildDefeaterAnalysis', () => {
  test('汇总各态数量', async () => {
    const llm = stubLlm([
      JSON.stringify({ defeaters: [
        { proposition: 'a', type: 'gap' },
        { proposition: 'b', type: 'gap' },
        { proposition: 'c', type: 'internal' },
        { proposition: 'd', type: 'internal' },
      ] }),
      JSON.stringify({ verdict: 'A' }),
      JSON.stringify({ verdict: 'B' }),
      JSON.stringify({ verdict: 'C' }),
      JSON.stringify({ verdict: 'C' }),
    ])
    const r = await buildDefeaterAnalysis({ proposition: 'P', corpus: 'C', llm })
    assert.deepEqual(r.summary, { total: 4, weakened: 1, strengthened: 1, resolved: 0, blank: 2, undecided: 0 })
  })
})

describe('渲染措辞纪律（不可退让）', () => {
  const results = [
    { id: 'D1', type: 'internal', proposition: '感谢领导 vs 离开',
      tension_between: '感激 / 离开', verdict: 'A', quotes: ['我很感谢领导'],
      contradiction_pair: ['我很感谢领导', '我一定该离开'], note: '存在张力' },
    { id: 'D2', type: 'gap', proposition: '领导认可足以弥补',
      evidence_needed: '权重', verdict: 'C', quotes: [], note: '无证据' },
    { id: 'D3', type: 'gap', proposition: '其实仍热爱编程', verdict: 'B', quotes: ['我相信我没有这种热爱了'], note: '被否定' },
  ]

  test('每条都以提问收尾', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    const questions = text.match(/？/g)?.length ?? 0
    assert.ok(questions >= results.length, `问句数 ${questions} 应不少于条目数 ${results.length}`)
  })

  test('不得出现指控性措辞', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    for (const forbidden of ['你矛盾', '自相矛盾', '你错了', '逻辑不严谨', '不一致',
                             '你连这个都', '显然', '你应该']) {
      assert.ok(!text.includes(forbidden), `不应出现：${forbidden}`)
    }
  })

  test('internal 型必须标明对立双方（让用户能判断是否误解）', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    assert.ok(text.includes('对立的两方'))
    assert.ok(text.includes('感激 / 离开'))
  })

  test('必须给出"这两句可能并不矛盾"的出路', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    assert.ok(text.includes('可能并不矛盾'))
    assert.ok(text.includes('如果我说错了'))
  })

  test('空白型必须说明这一点没有依据，且不得替用户假设答案', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    assert.ok(text.includes('没有依据'))
    assert.ok(text.includes('不会替你假设一个答案'))
  })

  test('R 态（本人已排除）的措辞不得说成"加强主判断"', () => {
    const text = renderDefeaterReport({ proposition: 'P', results: [
      { id: 'D1', type: 'internal', label: '领导认可足以留住他',
        tension_between: '感激 / 离开', verdict: 'R',
        quotes: ['我知道领导很好，但这不足以抵消'], note: '本人已给出理由排除' },
    ] })
    assert.ok(text.includes('你自己已经想过并排除了它'))
    assert.ok(!text.includes('加强了主判断'), 'R 不得说成加强主判断')
    assert.ok(text.includes('不再把它当作疑点'))
  })

  test('必须有"空白"汇总段（本设计最有价值的输出）', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    assert.ok(text.includes('最值得注意的：空白'))
    assert.ok(text.includes('建立在这些空白之上'))
  })

  test('结尾把判断权交回用户', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    assert.ok(text.includes('把综合判断交回你自己'))
  })

  test('空结果不崩', () => {
    const text = renderDefeaterReport({ proposition: 'P', results: [] })
    assert.ok(text.includes('如果要推翻'))
  })

  test('逐字原话被保留在输出里（可核对）', () => {
    const text = renderDefeaterReport({ proposition: 'P', results })
    assert.ok(text.includes('我很感谢领导'))
    assert.ok(text.includes('我相信我没有这种热爱了'))
  })
})

describe('已知事实作为证据源（闭环关键）', () => {
  test('renderFacts 只收有值的字段', () => {
    const block = renderFacts({
      现有存款: { value: 120000 },
      月税后收入: { value: null },
      外部机会: { value: '' },
      降薪接受度: { value: '不接受' },
      兼职收入: 0,
    })
    assert.ok(block.includes('现有存款：120000'))
    assert.ok(block.includes('降薪接受度：不接受'))
    assert.ok(!block.includes('月税后收入'), '空值不该写成事实')
    assert.ok(!block.includes('外部机会'), '空串不该写成事实')
    // 0 是有效值，必须保留
    assert.ok(block.includes('兼职收入：0'))
  })

  test('facts 为空时返回空串（不产生空标题）', () => {
    assert.equal(renderFacts(null), '')
    assert.equal(renderFacts({}), '')
    assert.equal(renderFacts({ a: { value: null } }), '')
  })

  test('检索提示里带上已知事实块', async () => {
    const calls = []
    const llm = async (msgs) => {
      calls.push(msgs[msgs.length - 1].content)
      if (msgs[0].content.includes('生成证伪项')) {
        return JSON.stringify({ defeaters: [{ proposition: '存款能撑多久', type: 'gap' }] })
      }
      return JSON.stringify({ verdict: 'B', quotes: ['存款 12 万'], note: '已知事实否定了它' })
    }
    await searchDefeaters({
      defeaters: [{ id: 'D1', type: 'gap', proposition: '存款能撑多久' }],
      corpus: '原文内容',
      facts: { 现有存款: { value: 120000 } },
      llm,
    })
    const searchPrompt = calls[calls.length - 1]
    assert.ok(searchPrompt.includes('已知事实'), '检索时必须带已知事实')
    assert.ok(searchPrompt.includes('现有存款：120000'))
    assert.ok(searchPrompt.includes('原文内容'), '原文也不能丢')
  })

  test('未传 facts 时提示里没有已知事实块（向后兼容）', async () => {
    let searchPrompt = ''
    const llm = async (msgs) => {
      if (msgs[0].content.includes('生成证伪项')) {
        return JSON.stringify({ defeaters: [{ proposition: 'x', type: 'gap' }] })
      }
      searchPrompt = msgs[msgs.length - 1].content
      return JSON.stringify({ verdict: 'C' })
    }
    await searchDefeaters({
      defeaters: [{ id: 'D1', type: 'gap', proposition: 'x' }],
      corpus: 'c',
      llm,
    })
    assert.ok(!searchPrompt.includes('【已知事实'))
  })

  test('buildDefeaterAnalysis 透传 facts', async () => {
    let sawFacts = false
    const llm = async (msgs) => {
      if (msgs[0].content.includes('生成证伪项')) {
        return JSON.stringify({ defeaters: [{ proposition: 'x', type: 'gap' }] })
      }
      if (msgs[msgs.length - 1].content.includes('已知事实')) sawFacts = true
      return JSON.stringify({ verdict: 'A' })
    }
    await buildDefeaterAnalysis({
      proposition: 'P', corpus: 'c', facts: { 存款: { value: 1 } }, llm,
    })
    assert.ok(sawFacts, 'facts 必须一路透传到检索阶段')
  })
})

describe('mylife_defeaters 工具（端到端）', () => {
  let tmp, cfg
  const toolStub = () => {
    let n = 0
    return async (msgs) => {
      if (msgs[0].content.includes('生成证伪项')) {
        return JSON.stringify({ defeaters: [
          { label: '领导认可足以留住他', proposition: '领导认可足以留住他', type: 'internal', tension_between: '感激 / 离开' },
          { label: '存款能撑几个月', proposition: '存款能撑几个月', type: 'gap', evidence_needed: '存款月数' },
        ] })
      }
      n += 1
      return n === 1
        ? JSON.stringify({ verdict: 'R', quotes: ['我知道领导很好'], note: '本人已排除' })
        : JSON.stringify({ verdict: 'C', quotes: [], note: '无证据' })
    }
  }

  test('未指定 file 时自动从工作区 raw/ 取语料', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-def-'))
    cfg = { workspaceRoot: tmp }
    await fs.mkdir(path.join(tmp, 'raw'), { recursive: true })
    await fs.writeFile(path.join(tmp, 'raw', 'a.md'), '这是一段测试原文，关于职业去留。', 'utf8')

    const v = await execute('mylife_defeaters', { proposition: '我该离开', _llm: toolStub() }, cfg)
    assert.ok(v.corpusChars > 5, '应从 raw/ 读到语料')
    assert.equal(v.summary.total, 2)
    assert.equal(v.summary.resolved, 1)
    assert.equal(v.summary.blank, 1)
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('语料为空时抛可读错误（而不是静默返回空报告）', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'mylife-empty-'))
    await assert.rejects(
      () => execute('mylife_defeaters', { proposition: 'P', _llm: toolStub() }, { workspaceRoot: empty }),
      /没有可用语料/,
    )
    await fs.rm(empty, { recursive: true, force: true })
  })

  test('渲染含空白汇总与免责收尾', async () => {
    const v = { rendered: 'x', corpusChars: 10, summary: { total: 1, weakened: 0, resolved: 0, strengthened: 0, blank: 1 } }
    const t = createTools({}).find((x) => x.name === 'mylife_defeaters')
    const out = t.output.render({}, v)[0].text
    assert.ok(out.includes('空白 1'))
    assert.ok(out.includes('本次分析了 10 字语料'))
  })
})

describe('LLM 配置解析', () => {
  test('缺失 key 时 resolveLlmConfig 返回 null 而不是抛错', async () => {
    const saved = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    const c = await resolveLlmConfig({ llm: { baseUrl: 'http://x' } })
    // 本机可能真的存在 ~/.dsh/.credentials.yaml，所以只断言类型正确
    assert.ok(c.apiKey === null || typeof c.apiKey === 'string')
    assert.equal(c.baseUrl, 'http://x')
    if (saved) process.env.DEEPSEEK_API_KEY = saved
  })

  test('配置优先于环境变量', async () => {
    process.env.DEEPSEEK_API_KEY = 'env-key'
    const c = await resolveLlmConfig({ llm: { apiKey: 'cfg-key', model: 'm1' } })
    assert.equal(c.apiKey, 'cfg-key')
    assert.equal(c.model, 'm1')
    delete process.env.DEEPSEEK_API_KEY
  })

  test('从 dsh 凭据文件读 key 的函数不抛错', async () => {
    const k = await readKeyFromDshCredentials()
    assert.ok(k === null || typeof k === 'string')
  })
})

// ─────────────────────────────────────────────────────────────
// 真实 API 冒烟测试：默认跳过
//   MYLIFE_LIVE_LLM=1 node --test test/defeater.test.js
// ─────────────────────────────────────────────────────────────
describe('真实 LLM 冒烟（默认跳过）', () => {
  test('能对一段真实自述生成证伪项并判定', { skip: !process.env.MYLIFE_LIVE_LLM }, async () => {
    const { createLlm } = await import('../src/lib/llm.js')
    const llm = await createLlm({})
    const corpus = [
      '我在这家公司待了两年，觉得每一天都不快乐，但又说不出具体原因。',
      '我的同事和领导都非常好，领导还给了我 A 绩效。',
      '我一定该离开这里，但想到领导对我这么好，又觉得很愧对他。',
      '我不太在意钱，可是食堂排队半小时、电梯九层停十三下这些事让我特别烦躁。',
    ].join('\n')

    const r = await buildDefeaterAnalysis({ proposition: '我该离开这家公司', corpus, llm })
    assert.ok(r.results.length >= 3, `证伪项过少：${r.results.length}`)
    for (const d of r.results) {
      assert.ok(['A', 'B', 'C', '?'].includes(d.verdict))
    }
    const text = renderDefeaterReport(r)
    assert.ok(text.includes('如果要推翻'))
    assert.ok(!text.includes('你矛盾'))
  })
})
