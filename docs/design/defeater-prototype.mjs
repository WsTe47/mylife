import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire('/Users/climber47/dsh-mylife/package.json')
const yaml = require('js-yaml')
const cred = yaml.load(await readFile(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8'))
const KEY = cred.refs.DEEPSEEK_API_KEY
const doc = await readFile('/tmp/doc.md', 'utf8')

async function llm(messages, { json = false, max = 1400 } = {}) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: max, temperature: 0.2,
      ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  })
  if (!r.ok) throw new Error(`API ${r.status}`)
  return (await r.json()).choices[0].message.content
}

const P = '我该离开这家公司'
const t0 = Date.now()

// 证伪项分两类：外部事实型 / 内在矛盾型
const gen = await llm([
  { role: 'system', content:
    '给定一个人的职业去留随笔与主判断 P，生成 6 条证伪项（defeaters），分两类各 3 条：\n\n' +
    '**类型一 · 内在矛盾型（internal）**：这个人自己在文中已经给出了与 P 张力的表述。\n' +
    '  注意：张力不一定是"反义词"，常见的是：\n' +
    '  - 对**不同对象**的相反评价（如"同事很好"但对"系统"不满）\n' +
    '  - **声明 vs 实际行为**（如"钱不重要"但最激烈的情绪都在待遇上）\n' +
    '  - **承认的小事 vs 强烈的反应**\n' +
    '  每条必须指出：是哪两句（或哪两个立场）在对立。\n\n' +
    '**类型二 · 空白型（gap）**：如果某条成立，P 就该被推翻，而**判定它所需的信息是这个人自己本来就有、但文中没给的**。\n' +
    '  （排除需要外部市场数据、他人配合才能回答的——只要本人能自答的）\n\n' +
    '每条给出：proposition（具体命题）、type（internal/gap）、evidence_needed（需要什么）、\n' +
    '  tension_between（仅 internal 填：对立的两方是什么）\n' +
    '只输出 JSON：{"defeaters":[...]}' },
  { role: 'user', content: `P：${P}\n\n随笔：\n${doc}` },
], { json: true, max: 2000 })

const { defeaters } = JSON.parse(gen)
console.log(`=== 证伪项（${defeaters.length} 条 / ${((Date.now()-t0)/1000).toFixed(1)}s）===\n`)
for (const [i, d] of defeaters.entries()) {
  console.log(`${i+1}. [${d.type}] ${d.proposition}`)
  if (d.tension_between) console.log(`   对立双方：${d.tension_between}`)
  console.log(`   需要：${d.evidence_needed}\n`)
}

console.log('=== 逐条回原文验证 ===\n')
for (const d of defeaters) {
  const r = await llm([
    { role: 'system', content:
      '判断「证伪项」在原文中的证据状况，严格三选一，禁止用常理补充：\n' +
      '  A = 找到支持它的原话（逐字引用）\n' +
      '  B = 找到否定它的原话（逐字引用）\n' +
      '  C = 原文完全没有相关证据\n' +
      '若是内在矛盾型，还需指出原文中对立的具体两句话。\n' +
      'JSON: {"verdict":"A|B|C","quotes":["逐字"],"contradiction_pair":["句1","句2"]|null,"note":"一句话"}' },
    { role: 'user', content: `证伪项：${d.proposition}\n类型：${d.type}\n需要：${d.evidence_needed}\n\n原文：\n${doc}` },
  ], { json: true, max: 800 })
  let j; try { j = JSON.parse(r) } catch { j = { verdict: '?', quotes: [], note: '解析失败' } }
  const label = { A: '✅ 有支持', B: '⛔ 被否定', C: '⬜ 无证据' }[j.verdict] ?? '?'
  console.log(`【${d.type}】${d.proposition.slice(0, 46)}… → ${label}`)
  if (j.contradiction_pair) console.log(`   对立：① ${String(j.contradiction_pair[0]).slice(0,46)} ② ${String(j.contradiction_pair[1]).slice(0,46)}`)
  for (const q of (j.quotes||[]).slice(0,2)) console.log(`   原话：${String(q).slice(0, 72)}`)
  console.log(`   ${j.note}\n`)
}
console.log(`总耗时 ${((Date.now()-t0)/1000).toFixed(1)}s`)
