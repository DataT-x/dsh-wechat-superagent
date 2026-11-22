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
   * ⚠️ 两条硬约束（都是踩过的坑）：
   *   1. **不能用 window.open** —— DSH 桌面端会开一个独立的 Electron 窗口，
   *      关掉它会把整个应用带退出（用户「一退出就全退了」）。
   *   2. **不能用 window.location 导航** —— 单页应用跳走后回不到会话界面。
   *   3. **不能用 iframe** —— 同上，且被 CSP 拦时行为不可控。
   *
   * 所以只能在**当前文档内**渲染：用 fetch 拿到设置页 HTML，把其中的
   * <style> 与 <body> 内容搬进一个覆盖层。设置页是我们自己的静态页面，
   * 不含相对资源引用，搬移是安全的。
   */
  function openPanel() {
    var url = '/wecom-superagent/ui?token=' + encodeURIComponent(TOKEN);
    var old = document.getElementById('wecom-sa-overlay');
    if (old) { old.remove(); return; }

    var wrap = document.createElement('div');
    wrap.id = 'wecom-sa-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#0f1115;'
      + 'display:flex;flex-direction:column;overflow:hidden';

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:10px 16px;background:#171a21;color:#e6e9ef;flex:0 0 auto;'
      + 'font:14px -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;'
      + 'border-bottom:1px solid #2a3040';
    var title = document.createElement('span');
    title.textContent = '企业微信 Superagent 设置';
    var close = document.createElement('button');
    close.textContent = '关闭 ✕';
    close.style.cssText = 'background:#2a3040;color:#e6e9ef;border:0;border-radius:6px;'
      + 'padding:6px 14px;cursor:pointer;font:inherit';
    close.onclick = function () { wrap.remove(); };
    bar.appendChild(title);
    bar.appendChild(close);

    var body = document.createElement('div');
    body.style.cssText = 'flex:1 1 auto;overflow:auto;background:#0f1115';
    body.innerHTML = '<div style="padding:40px;color:#98a0b3;font:14px system-ui">正在加载设置页…</div>';

    wrap.appendChild(bar);
    wrap.appendChild(body);
    document.body.appendChild(wrap);

    function onKey(ev) {
      if (ev.key === 'Escape') {
        wrap.remove();
        document.removeEventListener('keydown', onKey, true);
      }
    }
    document.addEventListener('keydown', onKey, true);

    // 拉取设置页并原地渲染
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (html) {
        if (!document.getElementById('wecom-sa-overlay')) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        // 把 <style> 搬进来（只搬一次）
        var styles = doc.querySelectorAll('style');
        for (var i = 0; i < styles.length; i++) {
          var st = document.createElement('style');
          st.textContent = styles[i].textContent;
          wrap.appendChild(st);
        }
        // 把 <body> 的节点搬进来
        body.innerHTML = '';
        var kids =doc.body.childNodes;
        for (var j = 0; j < kids.length; j++) {
          body.appendChild(document.importNode(kids[j], true));
        }
        // 内联脚本已被 DOMParser 丢弃（安全），需要单独重放
        var scripts = doc.querySelectorAll('script');
        for (var k = 0; k < scripts.length; k++) {
          try {
            var sc = document.createElement('script');
            sc.textContent = scripts[k].textContent;
            body.appendChild(sc);
          } catch (e) { /* 单个脚本失败不影响整体 */ }
        }
        // 覆盖层的根要能滚动到设置页自己的背景
        body.style.background = '#0f1115';
      })
      .catch(function (err) {
        body.innerHTML = '<div style="padding:40px;color:#f87171;font:14px system-ui">'
          + '无法加载设置页：' + String(err && err.message ? err.message : err)
          + '<br><br>也可以直接在浏览器打开：<br><code style="color:#4d6bfe">'
          + window.location.origin + url + '</code></div>';
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
