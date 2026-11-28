/* 速写本 · 前端逻辑
   —— 原本内联在 index.html 的 <script> 里，现在独立成文件，
      由 index.html 以 <script src="app.js" defer> 引入。
   ------------------------------------------------------------ */

/* entries.txt 每行一个日期（即 posts/ 下的文件名），新 → 旧 */

/* 围栏标记（反引号 x3），用转义写法避免源码里出现连续反引号 */
const FENCE = '\u0060\u0060\u0060';

const $ = id => document.getElementById(id);
let entries = [];        /* 已到期的（用于列表 / 搜索 / 路由） */
let allEntries = [];     /* 全部（含未到期，用于定时解锁与期号） */
const PAGE_SIZE = 5;
let byId = {};

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ================= 定时发布 front matter =================
   posts/xxx.md 头部可写：

     ---
     publish: 2026-09-25T20:00:00+08:00
     ---

   到点之前：不进目录、不进搜索、导航也跳过。
   没写 publish 时：按文件名日期当天 00:00 发布。
   -------------------------------------------------------- */
function parseFrontMatter(raw) {
  const m = raw.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) {
      meta[line.slice(0, i).trim().toLowerCase()] =
        line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  });
  return { meta, body: raw.slice(m[0].length) };
}

function publishAt(meta, id) {
  const raw = meta.publish || meta.pub || '';
  if (raw) {
    /* 纯日期 → 本地 00:00；"2026-09-25 20:00" 里的空格换成 T，Safari 才认 */
    const s = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T00:00:00' : raw.replace(' ', 'T');
    const t = Date.parse(s);
    if (!isNaN(t)) return t;
    console.warn('[速写本] publish 无法解析：' + raw + '（' + id + '）');
  }
  const t = Date.parse(id + 'T00:00:00');
  return isNaN(t) ? 0 : t;
}

/* ================= Markdown 渲染 ================= */
function inline(s) {
  return s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~|～～([^～]+)～～/g, (m, a, b) => '<del>' + (a || b) + '</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
}

function renderMD(src, ctx) {
  const FENCE = '\u0060\u0060\u0060';
  ctx = ctx || {};
  const blocks = ctx.blocks || (ctx.blocks = []);
  const htmls  = ctx.htmls  || (ctx.htmls  = []);   // ← 关键：声明 htmls

  /* 1. 围栏代码块 */
  const rx = new RegExp(FENCE + '[^\\n]*\\n([\\s\\S]*?)' + FENCE, 'g');
  src = src.replace(rx, (m, code) => {
    blocks.push(code);
    return '\u0000CODE' + (blocks.length - 1) + '\u0000';
  });

  /* 2. <details>：递归渲染内部，共享 blocks/htmls */
  src = src.replace(/<details>([\s\S]*?)<\/details>/gi, (m, inner) => {
    const sumM = inner.match(/<summary>([\s\S]*?)<\/summary>/i);
    const body = inner.replace(/<summary>[\s\S]*?<\/summary>/i, '');
    const sum = sumM ? esc(sumM[1].trim()) : '展开';
    const innerHTML = renderMD(body.trim(), ctx);
    htmls.push('<details><summary>' + sum + '</summary>' + innerHTML + '</details>');
    return '\u0000HTML' + (htmls.length - 1) + '\u0000';
  });

  /* 3. 原生 <figure>…</figure>：模板「本周图记」的写法 */
  src = src.replace(/<figure\b[\s\S]*?<\/figure>/gi, m => {
    htmls.push(m);
    return '\u0000HTML' + (htmls.length - 1) + '\u0000';
  });

  /* 4. Markdown 图片 ![alt](url) → <figure> */
  src = src.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, srcUrl) => {
    const imgSrc = srcUrl.replace(/^\.\.?\//, '');
    const caption = alt ? '<figcaption>' + inline(esc(alt)) + '</figcaption>' : '';
    const figureHtml =
      '<figure>' +
        '<img src="' + esc(imgSrc) + '" alt="' + esc(alt) + '" ' +
        'loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
        caption +
      '</figure>';
    htmls.push(figureHtml);
    return '\u0000HTML' + (htmls.length - 1) + '\u0000';
  });

  const lines = esc(src).split('\n');
  let out = '';
  let stack = [];
  let quote = false;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      // 先 inline 处理普通文本，再展开行内图片占位符
      let text = inline(para.join('<br>'));
      text = text.replace(/\u0000HTML(\d+)\u0000/g, (m, i) => htmls[+i]);
      out += '<p>' + text + '</p>';
      para = [];
    }
  };
  const closeQuote = () => { if (quote) { out += '</blockquote>'; quote = false; } };
  const closeLists = n => {
    while (stack.length > n) {
      const s = stack.pop();
      out += '</' + s.tag + '>';
      if (s.inject) out += '</li>';
    }
  };
  const flushAll = () => { closeQuote(); closeLists(0); flushPara(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    const codeM = line.match(/^\u0000CODE(\d+)\u0000\s*$/);
    if (codeM) { flushAll(); out += '<pre><code>' + esc(blocks[+codeM[1]]) + '</code></pre>'; continue; }

    const htmlM = line.match(/^\u0000HTML(\d+)\u0000\s*$/);
    if (htmlM) { flushAll(); out += htmls[+htmlM[1]]; continue; }

    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushAll(); out += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }

    if (/^(-{3,}|\*{3,})$/.test(t)) { flushAll(); out += '<hr>'; continue; }

    /* 表格：当前行含 |，下一行是 |---|---| 分隔行 */
    if (t.indexOf('|') !== -1 && i + 1 < lines.length) {
      const sep = lines[i + 1].trim();
      if (/^[\s|:-]+$/.test(sep) && sep.indexOf('-') !== -1 && sep.indexOf('|') !== -1) {
        flushAll();
        const cellsOf = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const aligns = cellsOf(sep).map(a =>
          a[0] === ':' && a[a.length - 1] === ':' ? 'center' :
          a[a.length - 1] === ':' ? 'right' : 'left');
        const mk = (c, k, tag2) =>
          '<' + tag2 + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>'
          + inline(c) + '</' + tag2 + '>';
        const head = cellsOf(t).map((c, k) => mk(c, k, 'th')).join('');
        let rows = '', j = i + 2;
        while (j < lines.length && lines[j].trim().indexOf('|') !== -1) {
          rows += '<tr>' + cellsOf(lines[j]).map((c, k) => mk(c, k, 'td')).join('') + '</tr>';
          j++;
        }
        out += '<table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>';
        i = j - 1;
        continue;
      }
    }

    /* 引用：esc 已把 > 转成 &gt;，按 &gt; 匹配；支持多行连续 */
    const q = t.match(/^&gt;\s?(.*)/);
    if (q) {
      flushPara(); closeLists(0);
      if (!quote) { out += '<blockquote>'; quote = true; }
      /* 外层「」交给 CSS 角标，正文里不用再写 */
      const qt = q[1].replace(/^「/, '').replace(/」$/, '');
      out += '<p>' + inline(qt) + '</p>';
      continue;
    }
    closeQuote();

    /* 列表：无序 / 有序 / 任务清单 / 长评段（*），支持任意层级嵌套
       注意：mUL[1] = 列表符号（- 或 *），mUL[2] = 内容 */
    const indent = line.replace(/\t/g, '  ').match(/^\s*/)[0].length;
    let tag = null, content = null, task = null, isStar = false;
    const mUL = t.match(/^([-*])\s+(.*)/);
    const mOL = t.match(/^\d+[.．]\s+(.*)/);
    if (mUL) {
      tag = 'ul';
      isStar = mUL[1] === '*';
      const tk = mUL[2].match(/^\[( |x|X)\]\s+(.*)$/);
      if (tk) { task = tk[1].toLowerCase() === 'x'; content = tk[2]; }
      else content = mUL[2];
    } else if (mOL) { tag = 'ol'; content = mOL[1]; }

    if (tag) {
      flushPara(); closeQuote();
      /* 关闭比当前更深的层级；同级但列表类型不同（ul↔ol 切换）也先关闭 */
      while (stack.length &&
            (stack[stack.length - 1].indent > indent ||
             (stack[stack.length - 1].indent === indent && stack[stack.length - 1].tag !== tag))) {
        closeLists(stack.length - 1);
      }
      /* 嵌套：把新列表挂进上一条 li 内 */
      let inject = false;
      if (stack.length && stack[stack.length - 1].indent < indent && out.slice(-5) === '</li>') {
        out = out.slice(0, -5);
        inject = true;
      }
      if (!stack.length || stack[stack.length - 1].indent < indent) {
        out += '<' + tag + '>';
        stack.push({ tag, indent, inject });
      }
      /* 输出条目 */
      if (task !== null) {
        out += '<li class="task"><input type="checkbox" disabled' + (task ? ' checked' : '') + '>' + inline(content) + '</li>';
      } else if (isStar && stack.length > 1) {
        /* 嵌套列表中的 * 条目 = 长评段 */
        out += '<li class="prose">' + inline(content) + '</li>';
      } else {
        out += '<li>' + inline(content) + '</li>';
      }
      continue;
    }
    closeLists(0);

    /* 空行 / 段落 */
    if (!t) { flushPara(); continue; }
    para.push(t);
  }
  flushAll();
  return out;
}


function parseEntry(id, raw, idx) {
  const fm = parseFrontMatter(raw);                 /* ← 剥掉 front matter */
  const lines = fm.body.split('\n');

  let title = '无题', start = 0;
  const m = lines[0] && lines[0].match(/^#\s+(.*)/);
  if (m) { title = m[1].trim(); start = 1; }
  const body = lines.slice(start).join('\n').replace(/^\s+/, '');

  let excerpt = '';
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    excerpt = t.replace(/^>\s?/, '').replace(/[*`>~\[\]!]/g, '').slice(0, 90);
    break;
  }
  return {
    id, title, excerpt, date: id,
    no: '第 ' + String(idx) + ' 期',
    body,
    pubAt: publishAt(fm.meta, id),                  /* ← 发布时间戳（ms） */
  };
}

function fmtDate(id) {
  const parts = id.split('-');
  return '<span class="yr">' + parts[0] + '</span> ' + parts[1] + '.' + parts[2];
}
function fmtDateFull(id) {
  return id.replace(/-/g, ' · ');
}

/* ================= 目录生成 + 滚动高亮 ================= */
let tocObs = null;

function initTOC() {
  const rail = $('tocRail');
  rail.innerHTML = '';
  if (tocObs) { tocObs.disconnect(); tocObs = null; }

  const body = document.querySelector('.post-body');
  if (!body) return;
  const heads = Array.from(body.querySelectorAll('h2, h3'));
  if (heads.length < 2) return;               /* 少于两节就不做目录 */

  /* 生成链接列表（同时用于侧栏和手机端折叠块） */
  const links = heads.map((h, i) => {
    h.id = 'sec-' + i;
    return '<a class="' + (h.tagName === 'H3' ? 'lv3' : '') + '" data-sec="sec-' + i + '">'
         + esc(h.textContent) + '</a>';
  }).join('');

  /* 桌面端侧栏 */
  rail.innerHTML = '<div class="toc-cap">本 期 目 录</div>' + links;

  /* 手机端折叠块，插入正文最前 */
  body.insertAdjacentHTML('afterbegin',
    '<details class="toc-inline"><summary>目 录</summary><nav>' + links + '</nav></details>');

  /* 点击滚动：不能用 # 锚点（会触发路由），用 JS 滚动 */
  document.querySelectorAll('.toc-rail a, .toc-inline nav a').forEach(a => {
    a.onclick = e => {
      e.preventDefault();
      const t = document.getElementById(a.dataset.sec);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });

  /* 滚动高亮（桌面侧栏） */
  tocObs = new IntersectionObserver(es => {
    es.forEach(en => {
      if (!en.isIntersecting) return;
      rail.querySelectorAll('a').forEach(a =>
        a.classList.toggle('on', a.dataset.sec === en.target.id));
    });
  }, { rootMargin: '-15% 0px -75% 0px' });
  heads.forEach(h => tocObs.observe(h));
}
/* ================= 搜索 ================= */
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function highlightTerms(html, terms) {
  if (!terms || !terms.length) return html;
  const pat = terms.map(escRe).filter(Boolean).join('|');
  if (!pat) return html;
  return String(html).replace(new RegExp('(' + pat + ')', 'gi'), '<mark>$1</mark>');
}

function stripMD(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~=|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeSnippet(e, terms) {
  const body = stripMD(e.body);
  if (!terms.length) return body.slice(0, 90);
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return body.slice(0, 90);
  const start = Math.max(0, idx - 24);
  const end = Math.min(body.length, idx + 66);
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}

function searchEntries(rawQuery) {
  const terms = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { terms, list: entries };
  const hits = [];
  for (const e of entries) {
    const title = e.title.toLowerCase();
    const excerpt = (e.excerpt || '').toLowerCase();
    const body = e.body.toLowerCase();
    let score = 0, ok = true;
    for (const t of terms) {
      const ti = title.indexOf(t);
      const ei = excerpt.indexOf(t);
      const bi = body.indexOf(t);
      if (ti < 0 && ei < 0 && bi < 0) { ok = false; break; }
      if (ti >= 0) score += 100 + Math.max(0, 30 - ti);
      else if (ei >= 0) score += 30;
      if (bi >= 0) score += 8;
    }
    if (ok) hits.push({ e, score });
  }
  hits.sort((a, b) => b.score - a.score || b.e.id.localeCompare(a.e.id));
  return { terms, list: hits.map(h => h.e) };
}

/* 目录页外壳只建一次；输入过程中不重建搜索框，空格/光标/输入法才稳 */
function ensureSearchShell(raw) {
  const view = $('view');
  let input = $('q');
  if (!input) {
    view.innerHTML =
      '<div class="search">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
        '<input type="search" id="q" placeholder="翻找旧页…" autocomplete="off">' +
        '<span class="search-count" id="searchCount" hidden></span>' +
      '</div>' +
      '<div id="result"></div>';
    input = $('q');
  }
  if (document.activeElement !== input) input.value = raw;   // 正在输入时绝不覆盖
  return input;
}

function showIndex(kw, page) {
  const raw = kw == null ? '' : String(kw);      // 原样保留，过滤时才 trim
  page = page || 1;
  $('tocRail').innerHTML = '';

  ensureSearchShell(raw);

  const { terms, list } = searchEntries(raw);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);
  const start = (page - 1) * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);

  let html = '<div class="index-list">';
  for (let i = 0; i < slice.length; i++) {
    const e = slice[i];
    const isLatest = !terms.length && start === 0 && i === 0;
    const snip = makeSnippet(e, terms);
    html +=
      '<a class="entry' + (isLatest ? ' entry-latest' : '') + '" href="#/' + e.id + '">' +
        '<div class="entry-date">' + fmtDate(e.date) + '<span class="entry-no">' + e.no + '</span></div>' +
        '<div class="entry-body">' +
          '<div class="entry-title">' + highlightTerms(esc(e.title), terms) +
            (isLatest ? '<span class="badge-new">最新</span>' : '') + '</div>' +
          (snip ? '<div class="entry-excerpt">' + highlightTerms(esc(snip), terms) + '</div>' : '') +
        '</div>' +
      '</a>';
  }
  html += '</div>';

  if (totalPages > 1) {
    html +=
      '<nav class="pager">' +
        '<button id="pgFirst"' + (page <= 1 ? ' disabled' : '') + ' title="首页">⏮ 首页</button>' +
        '<button id="pgPrev"'  + (page <= 1 ? ' disabled' : '') + '>← 前一页</button>' +
        '<span class="pg-info">' +
          '<input id="pgInput" type="number" min="1" max="' + totalPages + '" ' +
                'value="' + page + '" inputmode="numeric" aria-label="跳转页码">' +
          '<span class="pg-total"> / ' + totalPages + '</span>' +
        '</span>' +
        '<button id="pgNext"'  + (page >= totalPages ? ' disabled' : '') + '>后一页 →</button>' +
        '<button id="pgLast"'  + (page >= totalPages ? ' disabled' : '') + ' title="尾页">尾页 ⏭</button>' +
      '</nav>';
  }
  html += '<div class="empty"' + (total ? ' style="display:none"' : '') + '>没有找到这一页</div>';

  $('result').innerHTML = html;

  const count = $('searchCount');
  if (terms.length) { count.hidden = false; count.textContent = total + ' 条'; }
  else { count.hidden = true; count.textContent = ''; }

  /* ── 分页控件：首/尾/前后 + 页码输入，每次渲染后重新绑定 ── */
  const goPage = p => {
    p = parseInt(p, 10);
    if (!Number.isFinite(p)) p = 1;
    p = Math.min(Math.max(1, p), totalPages);
    if (p === page) return;
    showIndex(raw, p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const bindBtn = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  bindBtn('pgFirst', () => goPage(1));
  bindBtn('pgPrev',  () => goPage(page - 1));
  bindBtn('pgNext',  () => goPage(page + 1));
  bindBtn('pgLast',  () => goPage(totalPages));

  const pgInput = $('pgInput');
  if (pgInput) {
    pgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); goPage(pgInput.value); }
    });
    pgInput.addEventListener('focus', () => pgInput.select());
    pgInput.addEventListener('blur', () => {
      const v = parseInt(pgInput.value, 10);
      if (!Number.isFinite(v) || v < 1 || v > totalPages) pgInput.value = page;
    });
  }
}


function showPost(id) {
  const e = byId[id];
  if (!e) {
    /* 已被过滤掉，但文件确实存在 → 说明是「未到发布时间」 */
    const pending = allEntries.find(x => x.id === id);
    if (pending) {
      $('view').innerHTML =
        '<p class="empty" style="display:block">' +
          '这一期还没到解锁时间（' +
          new Date(pending.pubAt).toLocaleString('zh-CN', { hour12: false }) +
          '）<br>' +
          '<a href="#" data-back style="color:var(--seal)">回首页</a>' +
        '</p>';
      return;
    }
    $('view').innerHTML =
      '<p class="empty" style="display:block">这一页好像被撕掉了 <a href="#" data-back style="color:var(--seal)">回目录</a></p>';
    return;
  }
  const idx = entries.indexOf(e);
  const prev = entries[idx + 1];
  const next = entries[idx - 1];

  $('view').innerHTML =
    '<a class="back" href="#">_ ← 回目录</a>' +
    '<article class="post">' +
      '<div class="post-head">' +
        '<div class="post-date">' + e.no + ' · ' + fmtDateFull(e.date) + '</div>' +
        '<h1 class="post-title">' + esc(e.title) + '</h1>' +
      '</div>' +
      '<div class="post-body">' + renderMD(e.body) + '</div>' +
      '<nav class="post-nav">' +
        (prev
          ? '<a class="prev" href="#/' + prev.id + '"><span class="lbl">← 更早</span>' + esc(prev.title) + '</a>'
          : '<span></span>') +
        (next
          ? '<a class="next" href="#/' + next.id + '"><span class="lbl">更新 →</span>' + esc(next.title) + '</a>'
          : '') +
      '</nav>' +
    '</article>';

  $('view').querySelectorAll('.post-body img').forEach(img => {
    /* —— 修正相对 /journal/ 的路径 —— */
    const raw = img.getAttribute('src') || '';
    if (raw && !/^(https?:)?\/\//.test(raw) && !raw.startsWith('data:')) {
      let s = raw.replace(/^(?:\.\.?\/)+/, '');          // 去 ./ ../
      if (s.startsWith('/')) {                            // /pic/ → /journal/pic/
        const base = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
        s = base + s;
      }
      img.setAttribute('src', s);
    }
    img.style.cursor = 'zoom-in';
    img.onerror = () => {
      const d = document.createElement('div');
      d.className = 'img-broken';
      d.textContent = '〔图已失效' + (img.alt ? '：' + img.alt : '') + '〕';
      img.replaceWith(d);
    };
    img.onclick = () => { lbImg.src = img.src; lb.style.display = 'grid'; };
  });

  initTOC();          /* 生成目录（桌面侧栏 + 手机折叠块） */

  window.scrollTo(0, 0);
}

/* ================= 发布过滤 + 定时解锁 ================= */
function applyPublishFilter() {
  const now = Date.now();
  entries = allEntries.filter(e => e.pubAt <= now);
  byId = Object.fromEntries(entries.map(e => [e.id, e]));
}

/* 页面一直开着，到点自动解锁。
   setTimeout 上限约 24.8 天，超过就续期递归。 */
function scheduleUnlock() {
  const now = Date.now();
  const next = allEntries
    .filter(e => e.pubAt > now)
    .sort((a, b) => a.pubAt - b.pubAt)[0];
  if (!next) return;

  const delay = Math.min(next.pubAt - now, 2147483647);
  setTimeout(() => {
    const before = entries.length;
    applyPublishFilter();
    /* 只在目录视图刷新；正在读文章就不打扰 */
    if (entries.length > before && !/^#\/[\w-]+$/.test(location.hash)) {
      const q = document.getElementById('q');
      showIndex(q ? q.value : '', 1);
    }
    scheduleUnlock();
  }, delay + 500);
}

function route() {
  const m = location.hash.match(/^#\/([\w-]+)$/);
  if (m) showPost(m[1]);
  else showIndex('');
}

window.addEventListener('hashchange', () => { route(); lastRendered = location.hash || '#/'; });

/* 搜索输入：事件委托，全站只挂一次 */
$('view').addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  if (e.isComposing) return;            // 中文输入法组词中，不打断
  clearTimeout(showIndex._t);
  showIndex._t = setTimeout(() => showIndex(e.target.value, 1), 120);
});
$('view').addEventListener('compositionend', e => {
  if (e.target.id === 'q') showIndex(e.target.value, 1);   // 组词结束立即刷新
});

/* 空态里的「回首页 / 回目录」：原来是内联 onclick，这里改成事件委托 */
$('view').addEventListener('click', e => {
  const a = e.target.closest('[data-back]');
  if (a) { e.preventDefault(); location.hash = ''; }
});

const lb = $('lb'), lbImg = $('lbImg');
lb.onclick = () => lb.style.display = 'none';
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') lb.style.display = 'none';
});

/* ---------- 数据源：内联优先，回退到 fetch ---------- */
function loadPosts() {
  if (window.POSTS_DATA && window.POSTS_DATA.length) {
    return Promise.resolve(window.POSTS_DATA.slice());
  }
  return fetch('entries.txt').then(r => r.text()).then(txt => {
    const ids = txt.split('\n').map(s => s.trim()).filter(Boolean);
    return Promise.all(ids.map(id =>
      fetch('posts/' + id + '.md')
        .then(r => r.ok ? r.text() : Promise.reject(id))
        .then(raw => ({ id, raw }))
        .catch(() => null)
    )).then(list => list.filter(Boolean));
  });
}

/* ---------- localStorage 缓存 ---------- */
const CACHE_KEY = 'journal:posts:v1';
function readCache() {
  try { const d = JSON.parse(localStorage.getItem(CACHE_KEY)); if (d && d.length) return d; } catch (e) {}
  return null;
}
function writeCache(list) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) {} }

/* ---------- 骨架屏 ---------- */
function renderSkeleton() {
  if ($('view') && !$('view').innerHTML) {
    $('view').innerHTML =
      '<div class="skeleton" aria-hidden="true">' +
        '<div class="sk-row" style="width:40%"></div>' +
        '<div class="sk-row" style="width:90%"></div>' +
        '<div class="sk-row short" style="width:70%"></div>' +
        '<div class="sk-row" style="width:85%"></div>' +
      '</div>';
  }
}

/* ---------- 装配 + 路由（原 boot 逻辑抽出来） ---------- */
let lastRendered = null;   // 记录已渲染的路由，避免二次 boot 打断阅读

function boot(list) {
  allEntries = list.map((x, i) => parseEntry(x.id, x.raw, i));
  allEntries.sort((a, b) => b.id.localeCompare(a.id));
  allEntries.forEach((e, i) => { e.no = '第 ' + (allEntries.length - i) + ' 期'; });
  applyPublishFilter();
  if (entries.length) {
    $('range').textContent = entries[entries.length - 1].date + ' — ' + entries[0].date;
  }
  /* 首次进入 / 刷新：无内容或路由变了 → 渲染；
     二次 boot（缓存后校对）且仍在读同一篇 → 不打断 */
  const key = location.hash || '#/';
  if (!$('view').innerHTML.trim() || lastRendered !== key) {
    route();
    lastRendered = key;
  }
}

/* ---------- 启动 ---------- */
renderSkeleton();
const cached = readCache();
if (cached) boot(cached);                       // 有缓存：先秒出
loadPosts().then(list => {
  writeCache(list);
  boot(list);                                   // 拿到最新：校对/刷新一次
}).catch(() => {
  if (!cached) $('view').innerHTML = '<p class="empty" style="display:block">速写本还是空的</p>';
});

$('year').textContent = new Date().getFullYear();