/**
 * 日志适配器。
 *
 * 插件里不同模块的构造参数历史上可能是函数或对象，这里统一成：
 *   log.debug(msg, ...args) / log.info(...) / log.warn(...) / log.error(...)
 * 同时保留可调用形式（log('info', msg)），避免调用点写错就崩。
 */

const LEVELS = ['debug', 'info', 'warn', 'error']

/** console 兜底。 */
export function consoleLogger(prefix = '[wecom] ') {
  return makeLogger({
    debug: (m) => { /* 静默 */ },
    info: (m) => console.log(prefix + m),
    warn: (m) => console.warn(prefix + m),
    error: (m) => console.error(prefix + m),
  })
}

/** 把任意形态的 logger 适配成对象形式。 */
export function asLogger(input) {
  if (input === undefined || input === null) return consoleLogger()
  if (typeof input === 'function') {
    // 旧风格：log(level, msg, ...args)
    return makeLogger({
      debug: (m) => safeCall(input, 'debug', m),
      info: (m) => safeCall(input, 'info', m),
      warn: (m) => safeCall(input, 'warn', m),
      error: (m) => safeCall(input, 'error', m),
    })
  }
  if (typeof input === 'object') {
    const out = {}
    for (const level of LEVELS) {
      const fn = input[level]
      out[level] = (msg, ...args) => {
        if (typeof fn === 'function') {
          try { fn.call(input, msg, ...args) } catch { /* 忽略 */ }
        }
      }
    }
    return makeLogger(out)
  }
  return consoleLogger()
}

function makeLogger(impl) {
  const logger = {
    debug: (msg, ...args) => impl.debug(format(msg, args)),
    info: (msg, ...args) => impl.info(format(msg, args)),
    warn: (msg, ...args) => impl.warn(format(msg, args)),
    error: (msg, ...args) => impl.error(format(msg, args)),
  }
  // 兼容 log('info', msg) 的调用
  return Object.assign((level, msg, ...args) => {
    const fn = logger[level]
    if (typeof fn === 'function') fn(msg, ...args)
    else logger.info(msg, ...args)
  }, logger)
}

function safeCall(fn, level, msg) {
  try { fn(level, msg) } catch { /* 忽略 */ }
}

function format(msg, args) {
  if (!args || args.length === 0) return String(msg)
  let i = 0
  return String(msg).replace(/%[sd]/g, () => String(args[i++] ?? ''))
}
