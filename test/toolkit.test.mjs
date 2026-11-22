import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { defineTool, compileParameters, validateArgs, ToolArgsError } from '../src/tool-kit.js'

describe('compileParameters', () => {
  test('必填字段进 required 数组', () => {
    const s = compileParameters({
      a: { type: 'string', required: true },
      b: { type: 'number' },
    })
    assert.deepEqual(s.required, ['a'])
    assert.equal(s.properties.a.type, 'string')
    assert.equal(s.properties.a.required, undefined)
  })

  test('根对象禁止多余字段', () => {
    assert.equal(compileParameters({}).additionalProperties, false)
  })

  test('枚举与描述保留', () => {
    const s = compileParameters({ v: { type: 'string', enum: ['x', 'y'], description: '选一个' } })
    assert.deepEqual(s.properties.v.enum, ['x', 'y'])
    assert.equal(s.properties.v.description, '选一个')
  })

  test('数组带 items', () => {
    const s = compileParameters({ list: { type: 'array', items: { type: 'string' } } })
    assert.equal(s.properties.list.items.type, 'string')
  })

  test('嵌套对象', () => {
    const s = compileParameters({
      o: { type: 'object', properties: { k: { type: 'string', required: true } } },
    })
    assert.deepEqual(s.properties.o.required, ['k'])
    assert.equal(s.properties.o.additionalProperties, false)
  })

  test('数值边界', () => {
    const s = compileParameters({ n: { type: 'integer', minimum: 1, maximum: 10 } })
    assert.equal(s.properties.n.minimum, 1)
    assert.equal(s.properties.n.maximum, 10)
  })

  test('非法 type 抛错', () => {
    assert.throws(() => compileParameters({ x: { type: 'wat' } }), /type/)
  })

  test('空 enum 抛错', () => {
    assert.throws(() => compileParameters({ x: { type: 'string', enum: [] } }), /enum/)
  })
})

describe('validateArgs', () => {
  const schema = compileParameters({
    name: { type: 'string', required: true },
    count: { type: 'integer', minimum: 1, maximum: 5 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  })

  test('合法参数无违规', () => {
    assert.deepEqual(validateArgs(schema, { name: 'x', count: 3, mode: 'a', tags: ['t'] }), [])
  })

  test('缺必填', () => {
    assert.equal(validateArgs(schema, {}).length, 1)
  })

  test('类型错误', () => {
    assert.ok(validateArgs(schema, { name: 1 }).some((v) => v.includes('字符串')))
    assert.ok(validateArgs(schema, { name: 'x', count: 1.5 }).some((v) => v.includes('整数')))
  })

  test('越界', () => {
    assert.ok(validateArgs(schema, { name: 'x', count: 0 }).some((v) => v.includes('小于')))
    assert.ok(validateArgs(schema, { name: 'x', count: 9 }).some((v) => v.includes('大于')))
  })

  test('枚举外值', () => {
    assert.ok(validateArgs(schema, { name: 'x', mode: 'c' }).some((v) => v.includes('之一')))
  })

  test('数组元素类型', () => {
    assert.ok(validateArgs(schema, { name: 'x', tags: ['a', 2] }).some((v) => v.includes('tags[1]')))
  })

  test('拒绝多余字段', () => {
    assert.ok(validateArgs(schema, { name: 'x', extra: 1 }).some((v) => v.includes('多余字段')))
  })
})

describe('defineTool', () => {
  test('执行前校验参数', async () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      parameters: { a: { type: 'string', required: true } },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async (args) => ({ ok: true, a: args.a }),
    })
    await assert.rejects(() => tool.execute({}, {}), ToolArgsError)
    assert.deepEqual(await tool.execute({ a: 'x' }, {}), { ok: true, a: 'x' })
  })

  test('渲染前脱敏', () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      parameters: {},
      output: {
        schema: { type: 'object' },
        render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({}),
    })
    const blocks = tool.output.render({}, { token: 'abcdef123456', name: 'ok' })
    assert.ok(!blocks[0].text.includes('abcdef123456'))
  })

  test('未声明并发安全时默认 false', () => {
    const tool = defineTool({
      name: 't', description: 'd', parameters: {},
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    })
    assert.equal(tool.isConcurrencySafe({}), false)
  })

  test('声明并发安全且参数合法时为 true', () => {
    const tool = defineTool({
      name: 't', description: 'd',
      parameters: { a: { type: 'string', required: true } },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
      isConcurrencySafe: () => true,
    })
    assert.equal(tool.isConcurrencySafe({ a: 'x' }), true)
    assert.equal(tool.isConcurrencySafe({}), false)
  })

  test('产出的结构满足 DSH ToolDefinition 形状', () => {
    const tool = defineTool({
      name: 't', description: 'd', parameters: { a: { type: 'string' } },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'x' }] },
      execute: async () => ({}),
    })
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.output.schema)
  })
})

describe('DSH schema 约束：required 只能出现在 object 节点上', () => {
  /** DSH 的规则：类型节点（非 object）不得出现 required 布尔值。 */
  function findViolations(node, path = '$', out = []) {
    if (!node || typeof node !== 'object') return out
    if (Object.hasOwn(node, 'required')) {
      if (node.type !== 'object' || !Array.isArray(node.required)) {
        out.push(`${path}.required on type="${node.type}"`)
      }
    }
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) findViolations(v, `${path}.${k}`, out)
    if (node.items) findViolations(node.items, `${path}[]`, out)
    return out
  }

  test('compileParameters 把 required 注解编译成父对象的数组', () => {
    const s = compileParameters({
      a: { type: 'string', required: true },
      b: { type: 'boolean', required: true },
      c: { type: 'string' },
    })
    assert.deepEqual(s.required, ['a', 'b'])
    assert.equal(s.properties.a.required, undefined, '类型节点不应保留 required 布尔值')
    assert.deepEqual(findViolations(s), [])
  })

  test('嵌套对象同样只产出 required 数组', () => {
    const s = compileParameters({
      outer: {
        type: 'object',
        properties: { x: { type: 'number', required: true } },
      },
    })
    assert.deepEqual(s.properties.outer.required, ['x'])
    assert.equal(s.properties.outer.properties.x.required, undefined)
    assert.deepEqual(findViolations(s), [])
  })

  test('defineTool 产出的 tools 无 schema 违规（真实构建）', () => {
    const tool = defineTool({
      name: 'demo',
      description: 'd',
      parameters: { q: { type: 'string', required: true } },
      output: {
        // 注意：这里用 properties 而不是 schema —— 与 tools.js 的写法一致
        properties: {
          ok: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
        render: () => [{ type: 'text', text: 'x' }],
      },
      execute: async () => ({ ok: true, note: 'x' }),
    })
    assert.deepEqual(findViolations(tool.output.schema, '$out'), [])
    assert.deepEqual(tool.output.schema.required, ['ok'])
  })
})
