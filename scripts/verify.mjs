#!/usr/bin/env node
/**
 * 自检：在不需要 DSH 的前提下，尽可能验证插件的完整性。
 *   - 所有模块能被 import
 *   - 插件导出形状正确
 *   - 用假 ctx 跑一遍 apply（9 个工具 + 全部路由 + 两个关键监听）
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const srcDir = join(root, 'src')
const toUrl = (p) => pathToFileURL(p).href

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

let failures = 0
const fail = (msg) => { console.error('✗', msg); failures += 1 }
const ok = (msg) => console.log('✓', msg)

// 1. 所有模块可 import
const files = walk(srcDir)
let importFailures = 0
for (const file of files) {
  const rel = relative(root, file).split(sep).join('/')
  try {
    await import(toUrl(file))
  } catch (error) {
    fail(`${rel} 无法加载：${error.message}`)
    importFailures += 1
  }
}
if (importFailures === 0) ok(`${files.length} 个模块全部可加载`)

// 2. 入口形状
const mod = await import(toUrl(join(srcDir, 'index.js')))
if (typeof mod.apply !== 'function') fail('缺少 apply 导出')
if (typeof mod.name !== 'string' || mod.name.length === 0) fail('缺少 name 导出')
if (!Array.isArray(mod.inject)) fail('inject 应为数组')
if (!mod.Config) fail('缺少 Config schema')
if (failures === 0) ok(`入口导出正确（name=${mod.name}, inject=[${mod.inject.join(',')}]）`)

// 3. 假 ctx 跑 apply
const tools = []
const routes = []
const listeners = []
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: { register: (d) => { tools.push(d.name); return () => {} }, change() {} },
  on: (event) => { listeners.push(event); return () => {} },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  webServer: { register: (r) => { routes.push(`${r.kind} ${r.path}`); return () => {} } },
  get: () => null,
}
try {
  await mod.apply(fakeCtx, {})
  if (tools.length !== 9) fail(`工具数量应为 9，实际 ${tools.length}`)
  else ok('9 个工具注册成功')
  const hasGate = listeners.includes('tools/pre-execute')
  const hasApproval = listeners.includes('approval/request')
  if (!hasGate) fail('未监听 tools/pre-execute（审批闸失效）')
  if (!hasApproval) fail('未监听 approval/request（原生审批未接管）')
  if (hasGate && hasApproval) ok('审批闸与原生审批桥已挂载')
  if (routes.length < 15) fail(`路由过少（${routes.length}）`)
  else ok(`${routes.length} 条 HTTP 路由注册成功`)
} catch (error) {
  fail(`apply 失败：${error.message}`)
}

// 4. 必需的文件
for (const f of ['README.md', 'LICENSE', 'cordis.patch.yml', 'package.json']) {
  try { statSync(join(root, f)) } catch { fail(`缺少 ${f}`) }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部自检通过')
