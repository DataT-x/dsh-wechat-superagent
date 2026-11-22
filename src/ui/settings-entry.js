/**
 * 客户端设置入口。
 *
 * 背景：DSH 的设置面板（左上角「设置」→ 左侧菜单）是一个**客户端插件**，
 * 由官方包在编译期打进前端 bundle。第三方插件要往里加一栏，标准做法是
 * 写一个 `lib/client.js` 客户端插件；但那需要在 profile 里能解析到
 * `@deepseek-ai/dsh-client-ui-*` 这些包，而我们只依赖宿主提供。
 *
 * 我们改用 DSH 已经公开的网页注入机制：
 *   `ctx.on('webserver/index-inject', (table, peer) => ...)`
 * 往首页注入一小段脚本。脚本做两件事：
 *   1. 在设置面板的左侧导航里「追加」一行「企业微信 Superagent」；
 *   2. 点击时打开我们自己的设置页（同源的 `/wecom-superagent/ui`）。
 *
 * 为什么用「追加 DOM」而不是 React 插槽：
 *   - 不依赖任何客户端包的内部结构，官方改版也不会崩；
 *   - 复制现有导航项的样式类，视觉上与原生的保持一致；
 *   - 找不到设置面板时静默不做，绝不破坏原页面。
 */
import { files, readJson } from '../core/state.js'

/** 注入脚本里用到的标记，便于排查「到底注入没有」。 */
const MARKER = 'data-wecom-superagent-entry'

/**
 * 注册设置入口注入。
 * @param {object} params
 * @param {object} params.ctx
 * @param {() => string} params.getPanelToken 面板访问令牌
 * @param {{ debug: Function, warn: Function, error: Function }} params.log
 * @returns {() => void} disposer
 */
export function installSettingsEntry({ ctx, getPanelToken, log }) {
  if (typeof ctx.on !== 'function') return () => {}

  const handler = (table) => {
    let token = ''
    try { token = getPanelToken() } catch { return }
    if (typeof token !== 'string' || token.length === 0) return
    const src = buildInjectionScript(token)
    table.push({ kind: 'script', placement: 'body', text: src })
  }

  const off = ctx.on('webserver/index-inject', handler)
  if (typeof log === 'function') log.debug('设置入口注入已注册')
  return typeof off === 'function' ? off : () => {}
}

/**
 * 生成注入脚本。
 *
 * 逻辑要点（按顺序）：
 *   1. 等设置面板出现（MutationObserver），最多等 30 秒；
 *   2. 找到左侧导航容器：优先按「设置」面板里已知的文字定位；
 *   3. 克隆一个已有条目当模板，替换文字与点击行为；
 *   4. 已存在则不重复插入（幂等，页面重渲染也安全）。
 */
export function buildInjectionScript(token) {
  // 注意：字符串里绝不能出现 `</script`（会提前闭合标签）
  const safeToken = String(token).replace(/[^a-f0-9]/gi, '')
  return `(function(){
  var MARK = ${JSON.stringify(MARKER)};
  if (window.__wecomSuperagentEntry) return;
  window.__wecomSuperagentEntry = true;
  var TOKEN = ${JSON.stringify(safeToken)};
  var TRIED = 0;

  function findNav() {
    // 设置面板里的一组「可点条目」：找同时包含若干已知条目名的容器
    var KNOWN = ['通用设置','模型','内置插件','Agent 预设','账号与余额','更多'];
    var nodes = document.querySelectorAll('button,a,div[role=button],li');
    var best = null, bestScore = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var text = (el.textContent || '').trim();
      if (text.length > 24) continue;
      var score = 0;
      for (var k = 0; k < KNOWN.length; k++) if (text === KNOWN[k]) score += 1;
      if (score === 0) continue;
      var parent = el.parentElement;
      if (!parent) continue;
      // 父容器里应包含多个同类条目
      var siblings = parent.children ? parent.children.length : 0;
      if (siblings < 2) continue;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best ? best.parentElement : null;
  }

  function insert() {
    if (document.querySelector('[' + MARK + ']')) return true;
    var nav = findNav();
    if (!nav) return false;
    var template = null;
    for (var i = 0; i < nav.children.length; i++) {
      var c = nav.children[i];
      if (c.getAttribute && c.getAttribute(MARK)) continue;
      if ((c.textContent || '').trim().length > 0) { template = c; break; }
    }
    if (!template) return false;

    var item = template.cloneNode(true);
    item.setAttribute(MARK, '1');
    item.removeAttribute('aria-current');
    item.classList.remove('active');

    // 把文字换掉：保留原有图标节点，只替换文本节点
    var replaced = false;
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType === 3 && child.nodeValue.trim().length > 0) {
          child.nodeValue = '企业微信 Superagent';
          replaced = true;
          return true;
        }
        if (!replaced && child.nodeType === 1 && walk(child)) return true;
      }
      return false;
    })(item);
    if (!replaced) item.textContent = '企业微信 Superagent';

    item.style.cursor = 'pointer';
    item.addEventListener('click', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      window.open('/wecom-superagent/ui?token=' + encodeURIComponent(TOKEN), '_blank', 'noopener');
    }, true);

    nav.appendChild(item);
    return true;
  }

  function tick() {
    if (insert()) return;
    TRIED += 1;
    if (TRIED > 60) return; // 30 秒后放弃，绝不无限轮询
    setTimeout(tick, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick, { once: true });
  } else {
    tick();
  }
  // 设置面板是懒打开的：持续观察，出现就插入
  try {
    var mo = new MutationObserver(function(){ if (!document.querySelector('[' + MARK + ']')) insert(); });
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (e) { /* 老浏览器忽略 */ }
})();`
}

/** 从状态文件读面板令牌（与 http.js 共用同一份）。 */
export function readPanelToken() {
  const state = readJson(files.state(), {}) ?? {}
  return typeof state.panelToken === 'string' ? state.panelToken : ''
}
