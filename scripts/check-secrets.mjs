#!/usr/bin/env node
/**
 * 提交前自检：确保没有把凭据或个人档案带进仓库。
 *
 * 用法：
 *   npm run check-secrets          # 检查当前索引与工作区
 *   node scripts/check-secrets.mjs --history   # 额外扫描完整 git 历史（较慢）
 *
 * 退出码非 0 表示发现问题，可直接挂到 pre-commit 或 CI 上。
 *
 * 为什么需要它：本插件的使用方式决定了「工作区里全是个人数据」，
 * 而仓库是公开的。两者只隔一次 `git add -A`，所以需要一道机械的闸门。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const scanHistory = args.includes('--history')

/** 命中即报错的模式。 */
const PATTERNS = [
  { name: 'DeepSeek/OpenAI 风格密钥', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: '飞书 App ID', re: /\bcli_[a-z0-9]{16}\b/ },
  { name: 'Bearer 令牌', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '通用赋值式密钥', re: /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"']{16,}["']/i },
]

/** 绝不允许被跟踪的路径（个人档案四层 + 报告）。 */
const FORBIDDEN_TRACKED = [
  /^raw\//,
  /^digest\//,
  /^claims\//,
  /^profile\.yaml$/,
  /^fields\.yaml$/,
  /^index\.yaml$/,
  /^report-.*\.md$/,
  /^workspace\//,
  /(^|\/)\.credentials/,
  /(^|\/)\.env/,
]

/** 允许的例外（示例语料是刻意公开的虚构内容）。 */
const ALLOWLIST = [/^examples\/sample-workspace\//]

function sh(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function trackedFiles() {
  return sh('git', ['ls-files', '-z']).split('\0').filter(Boolean)
}

let problems = 0
const report = (msg) => {
  problems += 1
  console.log(`  ✗ ${msg}`)
}

// ── 1. 被跟踪的文件名是否违规 ──
console.log('① 检查被跟踪的路径')
const files = trackedFiles()
for (const f of files) {
  if (ALLOWLIST.some((a) => a.test(f))) continue
  if (FORBIDDEN_TRACKED.some((p) => p.test(f))) report(`个人档案类文件被跟踪：${f}`)
}
if (problems === 0) console.log(`  ✓ ${files.length} 个文件，无违规路径`)

// ── 2. 文件内容是否含密钥特征 ──
console.log('\n② 扫描文件内容')
let scanned = 0
for (const f of files) {
  if (!existsSync(f)) continue
  if (/\.(png|jpg|jpeg|gif|webp|ico|zip|gz|tgz|woff2?|node)$/i.test(f)) continue
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  for (const p of PATTERNS) {
    const m = p.re.exec(text)
    if (m) report(`${p.name} 出现在 ${f}：…${m[0].slice(0, 12)}…`)
  }
}
console.log(`  ✓ 已扫描 ${scanned} 个文本文件`)

// ── 3. 未跟踪但存在于工作区的敏感文件（提醒，不算失败）──
console.log('\n③ 提醒：工作区里的敏感文件（未跟踪，不会被提交）')
const untracked = sh('git', ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean)
const risky = untracked.filter((f) =>
  /(\.credentials|\.env|\.key$|\.pem$|^raw\/|^claims\/|^profile\.yaml$|^report-)/.test(f),
)
if (risky.length) {
  for (const f of risky.slice(0, 10)) console.log(`  · ${f}`)
  if (risky.length > 10) console.log(`  … 另有 ${risky.length - 10} 个`)
  console.log('  （这些已被 .gitignore 覆盖，仅提示）')
} else {
  console.log('  ✓ 无')
}

// ── 4. 可选：完整历史扫描 ──
if (scanHistory) {
  console.log('\n④ 扫描完整 git 历史（所有提交的所有内容）')
  let hist = ''
  try {
    hist = sh('git', ['log', '-p', '--all'])
  } catch {
    hist = ''
  }
  for (const p of PATTERNS) {
    const m = p.re.exec(hist)
    if (m) report(`历史中出现 ${p.name}：…${m[0].slice(0, 12)}…`)
  }
  if (hist) console.log(`  ✓ 已扫描 ${(hist.length / 1024 / 1024).toFixed(1)} MB 历史`)
}

console.log('')
if (problems) {
  console.log(`❌ 发现 ${problems} 个问题 —— 不要提交，先处理。`)
  process.exit(1)
}
console.log('✅ 未发现凭据或个人档案。')
