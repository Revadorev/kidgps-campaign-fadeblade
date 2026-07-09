// Publica campania FadeBlade pe Facebook (poza) + Instagram (carusel + reel)
// GitHub Actions. Imagini via raw.githubusercontent.com; reel video urcat la tmpfiles la runtime.
const fs = require('fs');
const https = require('https');
const path = require('path');

const PAGE_ID = '1569258516706375';
const IG_ID = '17841474113661916';
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const IG_TOKEN = process.env.IG_TOKEN;
const REPO_RAW = process.env.REPO_RAW;

if (!PAGE_TOKEN || !IG_TOKEN || !REPO_RAW) { console.error('Lipsesc secrete/env'); process.exit(1); }

function reqOnce(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? new URLSearchParams(body).toString() : null;
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers: {} };
    if (data) { opts.headers['Content-Type']='application/x-www-form-urlencoded'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    const r = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){resolve({raw:d})}}); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isTransient = e => /ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout/i.test(e && e.message || '');

// Retry pe erori de retea tranzitorii (ECONNRESET etc.) — nu lasa un blip sa pice tot jobul.
async function req(method, url, body) {
  let last;
  for (let i=0;i<4;i++){
    try { return await reqOnce(method, url, body); }
    catch(e){ last=e; if(!isTransient(e)) throw e; console.warn(`  ⟳ retry ${i+1}/4 (${e.message})`); await sleep(2000*(i+1)); }
  }
  throw last;
}

// Upload fisier local la tmpfiles -> URL public direct (cu retry, tmpfiles e instabil)
async function uploadTmp(filePath) {
  let last;
  for (let i=0;i<4;i++){
    try { return await uploadTmpOnce(filePath); }
    catch(e){ last=e; console.warn(`  ⟳ tmpfiles retry ${i+1}/4 (${e.message})`); await sleep(3000*(i+1)); }
  }
  throw last;
}
function uploadTmpOnce(filePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----up' + Date.now();
    const fileData = fs.readFileSync(filePath);
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: video/mp4\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileData, tail]);
    const r = https.request({ hostname:'tmpfiles.org', path:'/api/v1/upload', method:'POST',
      headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':body.length} },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try { const j=JSON.parse(d); resolve(j.data.url.replace('tmpfiles.org/','tmpfiles.org/dl/')); } catch(e){ reject(new Error('tmpfiles: '+d)); } }); });
    r.on('error', reject); r.write(body); r.end();
  });
}

async function waitContainer(id, token) {
  for (let i=0;i<40;i++){
    const s = await req('GET', `https://graph.facebook.com/v22.0/${id}?fields=status_code,status&access_token=${token}`);
    if (s.status_code==='FINISHED') return true;
    if (s.status_code==='ERROR') { console.error('  container ERROR', JSON.stringify(s)); return false; }
    await sleep(5000);
  }
  return false;
}

// ── Anti-dublare ──
async function fbPosted(caption) {
  const key = caption.substring(0,50).trim();
  const r = await req('GET', `https://graph.facebook.com/v22.0/${PAGE_ID}/posts?fields=message&limit=30&access_token=${PAGE_TOKEN}`);
  return (r.data||[]).some(m => (m.message||'').substring(0,50).trim()===key);
}
async function igPosted(caption, kind) { // kind: 'CAROUSEL_ALBUM' | 'REELS'
  const key = caption.substring(0,50).trim();
  const r = await req('GET', `https://graph.facebook.com/v22.0/${IG_ID}/media?fields=caption,media_type,media_product_type&limit=40&access_token=${IG_TOKEN}`);
  return (r.data||[]).some(m => {
    if ((m.caption||'').substring(0,50).trim()!==key) return false;
    return kind==='REELS' ? m.media_product_type==='REELS' : m.media_type==='CAROUSEL_ALBUM';
  });
}

// ── Facebook poza ──
async function postFB(post) {
  if (await fbPosted(post.fb.caption)) { console.log('  ⏭️ FB deja postat'); return; }
  const url = `${REPO_RAW}/${post.fb.image}`;
  const r = await req('POST', `https://graph.facebook.com/v22.0/${PAGE_ID}/photos`, {
    url, caption: post.fb.caption, access_token: PAGE_TOKEN
  });
  if (r.id || r.post_id) console.log(`  ✅ FB postat (${r.post_id||r.id})`);
  else console.error('  ❌ FB', JSON.stringify(r));
}

// ── Instagram carusel ──
async function postIGCarousel(post) {
  if (await igPosted(post.ig_carousel.caption, 'CAROUSEL_ALBUM')) { console.log('  ⏭️ IG carusel deja postat'); return; }
  const childIds = [];
  for (const img of post.ig_carousel.images) {
    const c = await req('POST', `https://graph.facebook.com/v22.0/${IG_ID}/media`, {
      image_url: `${REPO_RAW}/${img}`, is_carousel_item:'true', access_token: IG_TOKEN });
    if (!c.id) { console.error('  ❌ IG child', JSON.stringify(c)); return; }
    childIds.push(c.id);
  }
  for (const cid of childIds) if (!(await waitContainer(cid, IG_TOKEN))) return;
  const car = await req('POST', `https://graph.facebook.com/v22.0/${IG_ID}/media`, {
    media_type:'CAROUSEL', children: childIds.join(','), caption: post.ig_carousel.caption, access_token: IG_TOKEN });
  if (!car.id) { console.error('  ❌ IG carousel', JSON.stringify(car)); return; }
  if (!(await waitContainer(car.id, IG_TOKEN))) return;
  const pub = await req('POST', `https://graph.facebook.com/v22.0/${IG_ID}/media_publish`, { creation_id: car.id, access_token: IG_TOKEN });
  if (pub.id) console.log(`  ✅ IG carusel postat (${pub.id})`); else console.error('  ❌ IG carusel publish', JSON.stringify(pub));
}

// ── Instagram reel ──
async function postIGReel(post) {
  if (await igPosted(post.ig_reel.caption, 'REELS')) { console.log('  ⏭️ IG reel deja postat'); return; }
  // Reincearca tot ciclul upload->container: tmpfiles/ingestia IG pot esua tranzitoriu (container ERROR).
  for (let attempt=1; attempt<=3; attempt++){
    let videoUrl;
    try { videoUrl = await uploadTmp(post.ig_reel.video); }
    catch(e){ console.error(`  ❌ upload reel (incercarea ${attempt})`, e.message); await sleep(3000); continue; }
    const c = await req('POST', `https://graph.facebook.com/v22.0/${IG_ID}/media`, {
      media_type:'REELS', video_url: videoUrl, caption: post.ig_reel.caption, share_to_feed:'true', access_token: IG_TOKEN });
    if (!c.id) { console.error(`  ❌ IG reel container (incercarea ${attempt})`, JSON.stringify(c)); await sleep(3000); continue; }
    if (!(await waitContainer(c.id, IG_TOKEN))) { console.warn(`  ⟳ reel container ERROR, reincerc (${attempt}/3)`); await sleep(3000); continue; }
    const pub = await req('POST', `https://graph.facebook.com/v22.0/${IG_ID}/media_publish`, { creation_id: c.id, access_token: IG_TOKEN });
    if (pub.id) { console.log(`  ✅ IG reel postat (${pub.id})`); return; }
    console.error(`  ❌ IG reel publish (incercarea ${attempt})`, JSON.stringify(pub)); await sleep(3000);
  }
  console.error('  ❌ IG reel esuat dupa 3 incercari');
}

async function main() {
  const posts = JSON.parse(fs.readFileSync('posts.json','utf8'));
  const now = Math.floor(Date.now()/1000);
  const due = posts.filter(p => p.publish_unix <= now).sort((a,b)=>a.publish_unix-b.publish_unix);
  if (!due.length) { console.log(`Nicio postare due (${new Date(now*1000).toISOString()}).`); return; }

  console.log(`${due.length} postare(i) due:`);
  let failures = 0;
  const guard = async (label, fn) => {
    try { await fn(); }
    catch(e){ failures++; console.error(`  ❌ ${label} exceptie:`, e.message); }
  };
  for (const post of due) {
    console.log(`\n▶ ${post.id} (${post.publish_ro})`);
    await guard('FB', () => postFB(post));
    await sleep(2000);
    await guard('IG carusel', () => postIGCarousel(post));
    await sleep(2000);
    await guard('IG reel', () => postIGReel(post));
    await sleep(2000);
  }
  // Nu picam jobul pentru erori de continut individuale (evitam email-uri "All jobs failed"
  // cand cea mai mare parte e deja postata). Doar raportam.
  console.log(`\nGata. ${failures} actiune(i) esuata(e) — vor fi reincercate la urmatoarea rulare.`);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
