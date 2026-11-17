// gen-feed.js   Node ≥ 18，零依赖
// 用法: node gen-feed.js https://你的域名
const fs = require('fs');
const path = require('path');

const SITE = process.argv[2] || 'https://www.jinmajue.top/journal/';
const LIMIT = 20;                    // feed 里最多放几期

const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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

const now = Date.now();
const ids = fs.readFileSync('entries.txt','utf8')
              .split('\n').map(s=>s.trim()).filter(Boolean);

const items = [];
for(const id of ids){
  const file = path.join('posts', id + '.md');
  if(!fs.existsSync(file)) continue;
  const { meta, body } = parseFrontMatter(fs.readFileSync(file,'utf8'));
  const pubAt = publishAt(meta, id);
  if(pubAt > now) continue;            // ⚠️ 未到定时发布时间 → 不进 feed
  const lines = body.split('\n');
  let title = '无题';
  const t = lines[0] && lines[0].match(/^#\s+(.*)/);
  if(t) title = t[1].trim();
  let excerpt = '';
  for(const line of lines.slice(1)){
    const s = line.trim();
    if(!s || s.startsWith('#')) continue;
    excerpt = s.replace(/^>\s?/,'').replace(/[*`>~\[\]!]/g,'').slice(0,120);
    break;
  }
  items.push({ id, title, excerpt, pubAt });
}
items.sort((a,b)=>b.pubAt-a.pubAt);
const feed = items.slice(0, LIMIT);

const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>速写本 · Weekly Log</title>
  <subtitle>一周一页：看了什么、读了什么、想到什么</subtitle>
  <link rel="alternate" type="text/html" href="${SITE}/"/>
  <link rel="self" type="application/atom+xml" href="${SITE}/feed.xml"/>
  <id>${SITE}/</id>
  <updated>${new Date(feed[0]?.pubAt ?? now).toISOString()}</updated>
${feed.map(e => `  <entry>
    <title>${esc(e.title)}</title>
    <link rel="alternate" type="text/html" href="${SITE}/#/${e.id}"/>
    <id>${SITE}/#/${e.id}</id>
    <published>${new Date(e.pubAt).toISOString()}</published>
    <updated>${new Date(e.pubAt).toISOString()}</updated>
    <summary>${esc(e.excerpt)}</summary>
  </entry>`).join('\n')}
</feed>
`;
fs.writeFileSync('feed.xml', xml);
console.log(`feed.xml 已生成，共 ${feed.length} 期`);
