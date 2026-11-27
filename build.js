// build.js   Node ≥ 18，零依赖
// 用法: node build.js [站点URL]
//   e.g. node build.js https://www.jinmajue.top/journal
// 作用: 一次跑完两件事 ——
//   1) 把 entries.txt 列出的 posts/*.md 内联成 posts-data.js（消除首屏 N+1 请求）
//   2) 生成 feed.xml（Atom，每条含 <content type="html"> 全文）
const fs = require('fs');
const path = require('path');

const SITE  = (process.argv[2] || 'https://www.jinmajue.top/journal').replace(/\/$/, '');
const LIMIT = 20;                       // feed 里最多放几期
const POSTS_DIR = 'posts';

/* ==================== 共享工具 ==================== */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseFrontMatter(raw){
  const m = raw.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if(!m) return { meta:{}, body: raw };
  const meta = {};
  m[1].split('\n').forEach(line=>{
    const i = line.indexOf(':');
    if(i>0) meta[line.slice(0,i).trim().toLowerCase()]
            = line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');
  });
  return { meta, body: raw.slice(m[0].length) };
}

function publishAt(meta, id){
  const raw = meta.publish || meta.pub || '';
  if(raw){
    const s = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw+'T00:00:00' : raw.replace(' ','T');
    const t = Date.parse(s);
    if(!isNaN(t)) return t;
  }
  const t = Date.parse(id + 'T00:00:00');
  return isNaN(t) ? 0 : t;
}

/* ---- Markdown → HTML（与前端 renderMD 对齐的精简版，够 RSS 用）---- */
function inline(s){
  return s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~|～～([^～]+)～～/g, (m,a,b)=>'<del>'+(a||b)+'</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
}
function renderMD(src){
  const FENCE = '\u0060\u0060\u0060';
  const blocks = [];
  src = src.replace(new RegExp(FENCE+'[^\\n]*\\n([\\s\\S]*?)'+FENCE,'g'),
    (m,code)=>{ blocks.push(code); return '\u0000CODE'+(blocks.length-1)+'\u0000'; });
  const html = [];
  src = src.replace(/<figure>\s*\n?([\s\S]*?)<\/figure>/gi, (m,inner)=>{
    const imgM = inner.match(/<img\s[^>]*?src="([^"]*)"[^>]*>/i);
    const capM = inner.match(/<figcaption>([\s\S]*?)<\/figcaption>/i);
    let alt=''; if(imgM){ const a=imgM[0].match(/alt="([^"]*)"/i); alt=a?a[1]:''; }
    let h='<figure>';
    if(imgM) h+='<img src="'+imgM[1]+'" alt="'+esc(alt)+'">';
    if(capM) h+='<figcaption>'+inline(esc(capM[1].trim()))+'</figcaption>';
    h+='</figure>'; html.push(h); return '\u0000HTML'+(html.length-1)+'\u0000';
  });
  const lines = esc(src).split('\n');
  let out='', quote=false, para=[];
  const flushPara=()=>{ if(para.length){ out+='<p>'+inline(para.join('<br>'))+'</p>'; para=[]; } };
  const closeQuote=()=>{ if(quote){ out+='</blockquote>'; quote=false; } };
  for(const line of lines){
    const t=line.trim();
    const codeM=line.match(/^\u0000CODE(\d+)\u0000\s*$/);
    if(codeM){ closeQuote(); flushPara(); out+='<pre><code>'+esc(blocks[+codeM[1]])+'</code></pre>'; continue; }
    const htmlM=line.match(/^\u0000HTML(\d+)\u0000\s*$/);
    if(htmlM){ closeQuote(); flushPara(); out+=html[+htmlM[1]]; continue; }
    const h=t.match(/^(#{1,4})\s+(.*)/);
    if(h){ closeQuote(); flushPara(); out+='<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>'; continue; }
    if(/^(-{3,}|\*{3,})$/.test(t)){ closeQuote(); flushPara(); out+='<hr>'; continue; }
    const q=t.match(/^&gt;\s?(.*)/);
    if(q){ flushPara(); if(!quote){ out+='<blockquote>'; quote=true; }
      out+='<p>'+inline(q[1].replace(/^「/,'').replace(/」$/,''))+'</p>'; continue; }
    closeQuote();
    const mUL=t.match(/^[-*]\s+(.*)/), mOL=t.match(/^\d+[.．]\s+(.*)/);
    if(mUL){ flushPara(); out+='<li>'+inline(mUL[1])+'</li>'; continue; }
    if(mOL){ flushPara(); out+='<li>'+inline(mOL[1])+'</li>'; continue; }
    if(!t){ flushPara(); continue; }
    para.push(t);
  }
  closeQuote(); flushPara();
  return out;
}

/* 从正文里取标题 + 摘要（两个产物共用） */
function parseEntry(id, body){
  const lines = body.split('\n');
  let title = '无题';
  const t = lines[0] && lines[0].match(/^#\s+(.*)/);
  if(t) title = t[1].trim();
  const startIdx = (t ? 1 : 0);
  const contentBody = lines.slice(startIdx).join('\n');
  let excerpt = '';
  for(const line of lines.slice(startIdx)){
    const s = line.trim();
    if(!s || s.startsWith('#')) continue;
    excerpt = s.replace(/^>\s?/,'').replace(/[*`>~\[\]!]/g,'').slice(0,120);
    break;
  }
  return { title, contentBody, excerpt };
}

/* ==================== 主流程 ==================== */
const now = Date.now();
const ids = fs.readFileSync('entries.txt','utf8')
              .split('\n').map(s=>s.trim()).filter(Boolean);

const allPosts = [];   // 全部（含未到期）→ 给 posts-data.js
const feedItems = [];  // 仅已到期 → 给 feed.xml
for(const id of ids){
  const file = path.join(POSTS_DIR, id + '.md');
  if(!fs.existsSync(file)){ console.warn('跳过（缺文件）: ' + id); continue; }
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontMatter(raw);
  const pubAt = publishAt(meta, id);
  const { title, contentBody, excerpt } = parseEntry(id, body);

  allPosts.push({ id, raw });                    // 前端自己按 publish 过滤，故全量内联
  if(pubAt <= now){                              // 未到期不进 feed
    feedItems.push({ id, title, excerpt, pubAt, content: renderMD(contentBody) });
  }
}

/* —— 产物 1：posts-data.js —— */
const payload = JSON.stringify(allPosts).replace(/<\/script/gi, '<\\/script');
fs.writeFileSync('posts-data.js',
  '/* 由 build.js 自动生成，请勿手改 */\nwindow.POSTS_DATA = ' + payload + ';\n');
console.log('posts-data.js 已生成，共 ' + allPosts.length + ' 篇');

/* —— 产物 2：feed.xml —— */
feedItems.sort((a,b)=>b.pubAt - a.pubAt);
const feed = feedItems.slice(0, LIMIT);
const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/atom/ns#">
  <title>速写本 · Weekly Log</title>
  <subtitle>一周一页：看了什么、读了什么、想到什么</subtitle>
  <link rel="alternate" type="text/html" href="${SITE}/"/>
  <link rel="self" type="application/atom+xml" href="${SITE}/feed.xml"/>
  <id>${SITE}/</id>
  <updated>${new Date(feed[0]?.pubAt ?? now).toISOString()}</updated>
  <author>
    <name>vestjin</name>
    <uri>${SITE}/</uri>
  </author>
${feed.map(e => `  <entry>
    <title>${esc(e.title)}</title>
    <link rel="alternate" type="text/html" href="${SITE}/#/${e.id}"/>
    <id>${SITE}/#/${e.id}</id>
    <published>${new Date(e.pubAt).toISOString()}</published>
    <updated>${new Date(e.pubAt).toISOString()}</updated>
    <summary>${esc(e.excerpt)}</summary>
    <content type="html">${esc(e.content)}</content>
  </entry>`).join('\n')}
</feed>
`;
fs.writeFileSync('feed.xml', xml);
console.log(`feed.xml 已生成，共 ${feed.length} 期（含全文）`);