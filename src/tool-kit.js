/**
 * 工具定义的小适配器。
 *
 * 为什么不 `import { defineTool } from '@deepseek-ai/dsh-tools'`：
 *   1. DSH 的 profile 根目录**没有** `@deepseek-ai/dsh-tools`，
 *      第三方插件 import 它会在加载期直接失败；
 *   2. 它是打包产物里的内部包，版本随宿主变化；
 *   3. 我们要用到的能力（参数校验 + 输出渲染）十几行就能自己实现，
 *      顺手把「additionalProperties: false」和枚举校验做得更严格。
 *
 * 产出的对象形状与 DSH 的 `ToolDefinition` 完全一致：
 *   { name, description, parameters, output: { schema, render }, execute(args, exec) }
 */
import { redactDeep } from './core/redact.js'

/** 校验失败时抛这个，DSH 会把它变成工具错误返回给模型。 */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** 把「作者友好」的参数描述编译成标准 JSON Schema。 */
export function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec ?? {})) {
    // `required: true` 是参数表的注解：收集到数组里，不写进节点
    const isRequired = raw && typeof raw === 'object' && raw.required === true
    properties[key] = compileNode(raw, `parameters.${key}`)
    if (isRequired) required.push(key)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function compileNode(spec, path) {
  if (!spec || typeof spec !== 'object') throw new Error(`${path}: 参数描述必须是对象`)
  const out = {}
  if (typeof spec.type !== 'string' || !JSON_TYPES.has(spec.type)) {
    throw new Error(`${path}: type 必须是 ${[...JSON_TYPES].join('/')} 之一`)
  }
  out.type = spec.type
  if (typeof spec.description === 'string' && spec.description.length > 0) out.description = spec.description
  if (Array.isArray(spec.enum)) {
    if (spec.enum.length === 0) throw new Error(`${path}: enum 不能为空`)
    out.enum = spec.enum
  }
  if (spec.type === 'array') {
    out.items = spec.items ? compileNode(spec.items, `${path}[]`) : {}
  }
  if (spec.type === 'object') {
    if (spec.properties) {
      const nested = compileParameters(spec.properties)
      out.properties = nested.properties
      // `required` 是数组，直接挂在对象节点上（不是 `.required === true` 的布尔）
      if (nested.required) out.required = nested.required
    }
    out.additionalProperties = spec.additionalProperties === true
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    if (Number.isFinite(spec.minimum)) out.minimum = spec.minimum
    if (Number.isFinite(spec.maximum)) out.maximum = spec.maximum
  }
  if (typeof spec.default !== 'undefined') out.default = spec.default
  // 注意：required 的布尔标记只对外层参数表有意义（由 compileParameters 收集），
  // 绝不能写进节点，否则会把 object 类型的 required 数组冲掉。
  return out
}

/** 简单 JSON Schema 校验（只覆盖我们实际用到的子集）。 */
export function validateArgs(schema, value, path = '', required = false) {
  const violations = []
  const type = schema?.type
  const where = path || '(root)'
  if (value === undefined) {
    if (required) violations.push(`${where} 必填`)
    return violations
  }
  switch (type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${where} 应为字符串`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${where} 应为数字`)
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(`${where} 应为整数`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${where} 应为布尔值`)
      break
    case 'array':
      if (!Array.isArray(value)) { violations.push(`${where} 应为数组`); break }
      value.forEach((item, i) => {
        if (schema.items) violations.push(...validateArgs(schema.items, item, `${where}[${i}]`))
      })
      break
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${where} 应为对象`); break }
      const props = schema.properties ?? {}
      const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : [])
      for (const [key, prop] of Object.entries(props)) {
        violations.push(...validateArgs(prop, value[key], `${where}.${key}`, requiredKeys.has(key)))
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in props)) violations.push(`${where} 不接受多余字段 ${key}`)
        }
      }
      break
    }
    default:
      break
  }
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) {
    violations.push(`${where} 必须是 ${schema.enum.join(' / ')} 之一`)
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) violations.push(`${where} 不能小于 ${schema.minimum}`)
    if (Number.isFinite(schema.maximum) && value > schema.maximum) violations.push(`${where} 不能大于 ${schema.maximum}`)
  }
  return violations
}

/**
 * 定义一个工具。
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Record<string, object>} options.parameters
 * @param {{ schema: object, render: (args: any, value: any) => object[] }} options.output
 * @param {(args: any, exec: any) => Promise<any>} options.execute
 * @param {(args: any) => boolean} [options.isConcurrencySafe]
 */
export function defineTool({ name, description, parameters, output, execute, isConcurrencySafe }) {
  const compiled = compileParameters(parameters ?? {})
  return {
    name,
    description,
    parameters: compiled,
    output: {
      // 输出 schema 也用同一套编译器：作者写 `required: true` 是注解，
      // 编译后必须变成父对象的 `required: [...]` 数组。
      // （DSH 的 schema 编译器明确拒绝在类型节点上出现 required 布尔值，
      //   报错形如：`schema.properties.ok.required is not supported on type "boolean"`）
      schema: compileParameters(output.properties ?? {}),
      render: (args, value) => output.render(args, redactDeep(value)),
    },
    isConcurrencySafe: (args) => {
      if (typeof isConcurrencySafe !== 'function') return false
      try {
        if (validateArgs(compiled, args).length > 0) return false
        return isConcurrencySafe(args) === true
      } catch {
        return false
      }
    },
    async execute(args, exec) {
      const violations = validateArgs(compiled, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return execute(args, exec)
    },
  }
}
