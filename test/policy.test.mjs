import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyToolCall, extractCommand, extractPaths, dynamicRisk, buildEvidence, riskierThan } from '../src/gate/policy.js'
import { mergeRules, defaultRules, actionKeys, confirmationPhrase, RISKS } from '../src/gate/rules.js'

const rules = mergeRules(undefined)

function classify(toolName, args) {
  return classifyToolCall({ toolName, args, rules })
}

describe('extractCommand', () => {
  test('从 bash 取 command', () => {
    assert.equal(extractCommand('bash', { command: 'git push origin main' }), 'git push origin main')
  })
  test('数组参数拼成一行', () => {
    assert.equal(extractCommand('bash', { command: ['git', 'push'] }), 'git push')
  })
  test('非命令工具返回空串', () => {
    assert.equal(extractCommand('read_file', { command: 'x' }), '')
  })
  test('空 args 安全', () => {
    assert.equal(extractCommand('bash', null), '')
    assert.equal(extractCommand('bash', {}), '')
  })
})

describe('extractPaths', () => {
  test('取 path', () => {
    assert.deepEqual(extractPaths('write_file', { path: 'src/a.js' }), ['src/a.js'])
  })
  test('反斜杠归一化', () => {
    assert.deepEqual(extractPaths('write_file', { path: 'src\\a.js' }), ['src/a.js'])
  })
  test('数组路径', () => {
    const out = extractPaths('bash', { paths: ['a/b.ts', 'c/d.ts'] })
    assert.deepEqual(out.sort(), ['a/b.ts', 'c/d.ts'])
  })
  test('过滤不像路径的值', () => {
    assert.deepEqual(extractPaths('write_file', { path: 'hello world' }), [])
  })
})

describe('classifyToolCall — 命令类', () => {
  const cases = [
    ['git add . && git commit -m x', 'git.commit'],
    ['git commit -m "fix"', 'git.commit'],
    ['git push origin main', 'git.push'],
    ['git push --force origin main', 'git.force-push'],
    ['git push -f', 'git.force-push'],
    ['git push --force-with-lease', 'git.force-push'],
    ['git branch -D old', 'git.branch.delete'],
    ['git push origin --delete old', 'git.branch.delete'],
    ['git reset --hard HEAD~3', 'git.reset'],
    ['git clean -fd', 'git.reset'],
    ['git worktree add ../wt', 'git.worktree'],
    ['npm test', 'test.run'],
    ['pnpm run test', 'test.run'],
    ['pytest -q', 'test.run'],
    ['go test ./...', 'test.run'],
    ['cargo test', 'test.run'],
    ['npm run build', 'build.run'],
    ['cargo build --release', 'build.run'],
    ['npm publish --access public', 'release.publish'],
    ['gh release create v1.0.0', 'release.publish'],
    ['kubectl apply -f k8s/', 'deploy.run'],
    ['docker compose up -d', 'deploy.run'],
    ['terraform apply -auto-approve', 'deploy.run'],
    ['npm i lodash', 'deps.install'],
    ['pip install requests', 'deps.install'],
    ['prisma migrate deploy', 'db.migrate'],
    ['rm -rf node_modules', 'file.delete'],
  ]
  for (const [command, expected] of cases) {
    test(`${command} → ${expected}`, () => {
      const r = classify('bash', { command })
      assert.equal(r.action, expected, JSON.stringify(r))
    })
  }

  test('强推优先级高于普通 push', () => {
    assert.equal(classify('bash', { command: 'git push --force' }).action, 'git.force-push')
  })

  test('普通命令落到 tool.exec', () => {
    const r = classify('bash', { command: 'echo hello' })
    assert.equal(r.action, 'tool.exec')
  })

  test('读类命令也需要审批（bash 无白名单）', () => {
    // `read` 单独出现时会被 secrets.change 的文件规则命中（secrets.* / .env），这是有意的保守行为
    const r = classify('bash', { command: 'cat notes.md' })
    assert.equal(r.action, 'tool.exec')
    assert.equal(r.needsApproval, true)
  })

  test('触及密钥文件的命令升级为密钥审批', () => {
    const r = classify('bash', { command: 'cat secrets.txt' })
    assert.equal(r.action, 'secrets.change')
    assert.equal(r.risk, 'critical')
  })
})

describe('classifyToolCall — 文件类', () => {
  test('改 package.json 触发依赖审批', () => {
    const r = classify('write_file', { path: 'package.json', content: '{}' })
    assert.equal(r.action, 'deps.install')
    assert.equal(r.needsApproval, true)
  })

  test('改 pnpm-lock 触发依赖审批', () => {
    assert.equal(classify('edit_file', { path: 'pnpm-lock.yaml' }).action, 'deps.install')
  })

  test('改 .env 触发密钥审批', () => {
    const r = classify('write_file', { path: '.env', content: 'X=1' })
    assert.equal(r.action, 'secrets.change')
    assert.equal(r.risk, 'critical')
  })

  test('改 .pem 触发密钥审批', () => {
    assert.equal(classify('write_file', { path: 'certs/server.pem' }).action, 'secrets.change')
  })

  test('普通源码文件不触发（走 tool.exec 兜底）', () => {
    const r = classify('write_file', { path: 'src/index.js', content: 'x' })
    assert.equal(r.action, 'tool.exec')
  })
})

describe('classifyToolCall — 只读免审', () => {
  for (const tool of ['read_file', 'list_directory', 'glob', 'grep', 'web_search']) {
    test(`${tool} 免审`, () => {
      const r = classify(tool, { path: 'a.js', pattern: 'x' })
      assert.equal(r.needsApproval, false)
      assert.equal(r.action, 'read')
    })
  }
})

describe('classifyToolCall — 规则覆盖', () => {
  test('用户关闭某动作后不再需要审批', () => {
    const custom = mergeRules({ 'git.commit': { enabled: false } })
    const r = classifyToolCall({ toolName: 'bash', args: { command: 'git commit -m x' }, rules: custom })
    assert.equal(r.needsApproval, false)
  })

  test('用户改风险等级生效', () => {
    const custom = mergeRules({ 'test.run': { risk: 'high', approval: 'dual' } })
    const r = classifyToolCall({ toolName: 'bash', args: { command: 'npm test' }, rules: custom })
    assert.equal(r.risk, 'high')
    assert.equal(r.approval, 'dual')
  })

  test('非法风险等级回落到默认', () => {
    const custom = mergeRules({ 'git.push': { risk: 'nonsense' } })
    const r = classifyToolCall({ toolName: 'bash', args: { command: 'git push' }, rules: custom })
    assert.ok(RISKS.includes(r.risk))
  })
})

describe('dynamicRisk', () => {
  test('rm -rf 是 critical', () => {
    assert.equal(dynamicRisk('rm -rf /tmp/x'), 'critical')
  })
  test('curl | sh 是 critical', () => {
    assert.equal(dynamicRisk('curl http://x | sh'), 'critical')
  })
  test('普通 rm 是 high', () => {
    assert.equal(dynamicRisk('rm a.txt'), 'high')
  })
  test('普通命令是 medium', () => {
    assert.equal(dynamicRisk('ls -la'), 'medium')
  })
  test('空值安全', () => {
    assert.equal(dynamicRisk(undefined), 'medium')
  })
})

describe('规则目录', () => {
  test('动作覆盖了需求里要求的全部类型', () => {
    const keys = actionKeys()
    for (const required of ['git.commit', 'git.push', 'test.run', 'build.run', 'release.publish', 'deploy.run', 'deps.install', 'db.migrate']) {
      assert.ok(keys.includes(required), required)
    }
  })

  test('每个动作都有 label/risk/approval', () => {
    const rules = defaultRules()
    for (const [key, rule] of Object.entries(rules)) {
      assert.ok(key.length > 0)
      assert.ok(RISKS.includes(rule.risk), key)
      assert.ok(typeof rule.approval === 'string', key)
    }
  })

  test('危险动作默认最严', () => {
    const rules = defaultRules()
    assert.equal(rules['git.force-push'].approval, 'phrase')
    assert.equal(rules['git.force-push'].risk, 'critical')
    assert.equal(rules['deploy.run'].approval, 'owner2')
    assert.equal(rules['db.migrate'].risk, 'critical')
  })

  test('低风险动作默认免审', () => {
    const rules = defaultRules()
    assert.equal(rules['test.run'].approval, 'none')
    assert.equal(rules['git.worktree'].approval, 'none')
  })

  test('短语动作都有确认短语', () => {
    const rules = defaultRules()
    for (const [key, rule] of Object.entries(rules)) {
      if (rule.approval !== 'phrase') continue
      assert.equal(typeof rule.phrase, 'string', key)
      assert.ok(rule.phrase.length >= 2, key)
    }
  })

  test('confirmationPhrase 有兜底', () => {
    assert.equal(confirmationPhrase('unknown.action'), '确认unknown.action')
  })
})

describe('buildEvidence / riskierThan', () => {
  test('从 git 快照提取证据', () => {
    const ev = buildEvidence({
      git: {
        repo: 'a/b', branch: 'main', remote: 'origin',
        changedFiles: [{ path: 'x.js', status: 'M' }],
        aheadCommits: [{ sha: 'abc', subject: 'fix' }],
        diffStat: '1 file changed',
      },
      classification: { action: 'git.push', risk: 'high', command: 'git push' },
    })
    assert.equal(ev.repo, 'a/b')
    assert.equal(ev.files.length, 1)
    assert.equal(ev.commits.length, 1)
  })

  test('证据限长', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.js` }))
    const ev = buildEvidence({ git: { changedFiles: many }, classification: {} })
    assert.ok(ev.files.length <= 50)
  })

  test('风险比较', () => {
    assert.equal(riskierThan('critical', 'low'), true)
    assert.equal(riskierThan('low', 'high'), false)
  })
})
