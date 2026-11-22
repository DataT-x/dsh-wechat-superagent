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

  /**
   * 找到设置面板左侧的导航容器。
   *
   * 做法：先收集所有「文字恰好等于某个已知条目」的元素，
   * 再向上找它们共同的父容器。这样不依赖标签类型
   * （DSH 可能用 div/button/li，也可能改版换掉）。
   */
  function findNav() {
    var KNOWN = ['通用设置', '模型', '内置插件', 'Agent 预设', '账号与余额', '更多',
                 'IM 机器人', '桌宠配置', '插件市场', '通知提醒', '桌面控制'];
    // 找所有文字命中已知项、且没有更小的同类子元素的节点
    var all = document.body.getElementsByTagName('*');
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var text = (el.textContent || '').trim();
      if (text.length === 0 || text.length > 24) continue;
      var exact = false;
      for (var k = 0; k < KNOWN.length; k++) {
        if (text === KNOWN[k]) { exact = true; break; }
      }
      if (!exact) continue;
      // 只要最内层的那个（避免把外层容器也算进来）
      var inner = false;
      for (var c = 0; c < el.children.length; c++) {
        var ct = (el.children[c].textContent || '').trim();
        if (ct === text) { inner = true; break }
      }
      if (inner) continue;
      hits.push(el);
    }
    if (hits.length < 2) return null;

    // 取这些命中元素的共同父容器：从第一个开始向上找，
    // 能覆盖最多命中的那个父节点就是导航容器。
    var bestParent = null, bestCount = 0;
    for (var h = 0; h < hits.length; h++) {
      var p = hits[h].parentElement;
      if (!p) continue;
      var count = 0;
      for (var m = 0; m < hits.length; m++) {
        if (p.contains(hits[m])) count += 1;
      }
      // 父容器不应包含太多命中（说明层级太浅，是整页）
      if (count >= 2 && count > bestCount) { bestCount = count; bestParent = p; }
    }
    return bestParent;
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
    item.style.cursor = 'pointer';

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

    // ⚠️ 不在这里绑 click：
    // 克隆节点继承了 React 的事件系统，我们的监听器可能被它的重渲染冲掉。
    // 改成在 document 上做事件委托（见下方 installDelegate），一次绑好，永不失效。
    nav.appendChild(item);
    return true;
  }

  function tick() {
    if (insert()) return;
    TRIED += 1;
    if (TRIED > 60) return; // 30 秒后放弃，绝不无限轮询
    setTimeout(tick, 500);
  }

  /**
   * 打开设置页。
   *
   * 三条硬约束（都是踩过的坑）：
   *   1. 不能用 window.open —— DSH 桌面端会开独立 Electron 窗口，
   *      关掉它会把整个应用带退出。
   *   2. 不能把设置页 HTML 直接塞进主文档 —— 它的 body/:root/* 规则
   *      会污染 DSH 自己的样式，关掉后界面还是坏的。
   *   3. 不能用 location 导航 —— 单页应用跳走后回不到会话。
   *
   * 结论：用**同源 iframe**。样式与脚本天然隔离，关闭只是移除节点，
   * 对 DSH 零副作用。
   */
  function openPanel() {
    var existing = document.getElementById('wecom-sa-overlay');
    if (existing) { existing.remove(); return; }

    var url = '/wecom-superagent/ui?token=' + encodeURIComponent(TOKEN);

    var wrap = document.createElement('div');
    wrap.id = 'wecom-sa-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;'
      + 'background:#0f1115;display:flex;flex-direction:column;overflow:hidden';

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:10px 16px;background:#171a21;color:#e6e9ef;flex:0 0 auto;'
      + 'font:14px -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;'
      + 'border-bottom:1px solid #2a3040';

    var title = document.createElement('span');
    title.textContent = '企业微信 Superagent 设置';

    var actions = document.createElement('span');

    var openNew = document.createElement('button');
    openNew.textContent = '在浏览器打开';
    openNew.style.cssText = 'background:transparent;color:#98a0b3;border:1px solid #2a3040;'
      + 'border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;margin-right:8px';

    var close = document.createElement('button');
    close.textContent = '返回 DSH ✕';
    close.style.cssText = 'background:#4d6bfe;color:#fff;border:0;border-radius:6px;'
      + 'padding:7px 16px;cursor:pointer;font:inherit;font-weight:600';

    function teardown() {
      try { wrap.remove() } catch (e) { /* ignore */ }
      try { document.removeEventListener('keydown', onKey, true) } catch (e) { /* ignore */ }
    }
    close.onclick = teardown;
    // 兜底：「在浏览器打开」用 a[target=_blank] 的等价物，
    // 但桌面端 window.open 会毁应用，所以这里只复制链接。
    openNew.onclick = function () {
      var full = window.location.origin + url;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(full);
          openNew.textContent = '链接已复制';
          setTimeout(function () { openNew.textContent = '在浏览器打开' }, 1800);
          return;
        }
      } catch (e) { /* fall through */ }
      prompt('复制这个地址到浏览器打开：', full);
    };

    actions.appendChild(openNew);
    actions.appendChild(close);
    bar.appendChild(title);
    bar.appendChild(actions);

    var frame = document.createElement('iframe');
    frame.src = url;
    frame.setAttribute('allow', 'clipboard-write');
    frame.style.cssText = 'flex:1 1 auto;width:100%;border:0;background:#0f1115;display:block';

    wrap.appendChild(bar);
    wrap.appendChild(frame);
    document.body.appendChild(wrap);

    function onKey(ev) {
      if (ev.key === 'Escape') teardown();
    }
    document.addEventListener('keydown', onKey, true);

    // 点遮罩最外层（未被 iframe 覆盖的边）也能退出
    wrap.addEventListener('mousedown', function (ev) {
      if (ev.target === wrap) teardown();
    });
  }

  function installDelegate() {
    if (window.__wecomSuperagentDelegate) return;
    window.__wecomSuperagentDelegate = true;
    document.addEventListener('click', function(ev) {
      var el = ev.target;
      while (el && el !== document.body) {
        if (el.getAttribute && el.getAttribute(MARK)) {
          ev.preventDefault();
          ev.stopPropagation();
          openPanel();
          return;
        }
        el = el.parentElement;
      }
    }, true);
  }

  installDelegate();
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
