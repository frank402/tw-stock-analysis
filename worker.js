/**
 * 台股智析 · Cloudflare Worker Proxy
 * 
 * 部署步驟：
 * 1. 前往 https://workers.cloudflare.com 註冊免費帳號
 * 2. Create Worker → 貼上這段程式碼 → Deploy
 * 3. 複製你的 Worker 網址（格式：https://xxx.your-account.workers.dev）
 * 4. 貼到 index.html 的 WORKER_URL 設定中
 * 
 * 免費額度：每天 100,000 次請求，完全夠用
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

export default {
  async fetch(request) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const type = url.searchParams.get('type');

    try {
      switch (type) {
        case 'twse_stock':    return await handleTWSEStock(url);
        case 'twse_index':    return await handleTWSEIndex();
        case 'twse_movers':   return await handleTWSEMovers(url);
        case 'yahoo':         return await handleYahoo(url);
        case 'rss':           return await handleRSS(url);
        default:
          return json({ error: 'Unknown type. Use: twse_stock, twse_index, twse_movers, yahoo, rss' }, 400);
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ── TWSE 個股即時行情 ──────────────────────────────────────────
// 用法: ?type=twse_stock&codes=2330,2317,2454
async function handleTWSEStock(url) {
  const codes = url.searchParams.get('codes') || '';
  const exCh  = codes.split(',').map(c => `tse_${c.trim()}.tw`).join('|');
  const apiUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;

  const res  = await fetch(apiUrl, {
    headers: { 'Referer': 'https://mis.twse.com.tw/' }
  });
  const data = await res.json();

  // 整理成乾淨格式
  const stocks = {};
  (data.msgArray || []).forEach(item => {
    const code     = item.c;
    const price    = parseFloat(item.z) || parseFloat(item.y) || 0;
    const prev     = parseFloat(item.y) || 0;
    const change   = +(price - prev).toFixed(2);
    const changePct= prev > 0 ? +((change / prev) * 100).toFixed(2) : 0;
    stocks[code] = {
      name      : item.n || code,
      price, change, changePct,
      open      : parseFloat(item.o) || 0,
      high      : parseFloat(item.h) || 0,
      low       : parseFloat(item.l) || 0,
      prev,
      volume    : parseInt(item.v) || 0,
      time      : item.t || '',
    };
  });
  return json({ stocks, ts: Date.now() });
}

// ── TWSE 大盤加權指數 ──────────────────────────────────────────
// 用法: ?type=twse_index
async function handleTWSEIndex() {
  const res  = await fetch(
    'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0',
    { headers: { 'Referer': 'https://mis.twse.com.tw/' } }
  );
  const data = await res.json();
  const item = data.msgArray?.[0];
  if (!item) return json({ error: 'No index data' }, 503);

  const price    = parseFloat(item.z) || parseFloat(item.y) || 0;
  const prev     = parseFloat(item.y) || 0;
  const change   = +(price - prev).toFixed(2);
  const changePct= prev > 0 ? +((change / prev) * 100).toFixed(2) : 0;

  return json({ price, prev, change, changePct, time: item.t, ts: Date.now() });
}

// ── TWSE 盤後成交資料（漲跌幅排行）────────────────────────────
// 用法: ?type=twse_movers&date=20250220
async function handleTWSEMovers(url) {
  // 先試今天，若盤未結算則回昨天資料
  let date = url.searchParams.get('date') || todayStr();
  
  const fetchMovers = async (d) => {
    const r = await fetch(
      `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date=${d}&response=json`,
      { headers: { 'Referer': 'https://www.twse.com.tw/' } }
    );
    return r.json();
  };

  let data = await fetchMovers(date);
  // 若無資料（假日/盤中）退回前一交易日
  if (!data.data || data.stat !== 'OK') {
    const prev = prevTradingDay(date);
    data = await fetchMovers(prev);
    date = prev;
  }

  if (!data.data) return json({ error: 'No movers data', date }, 503);

  // data.data: [代號, 名稱, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌(+/-), 漲跌價差]
  const stocks = data.data.map(row => ({
    code      : row[0]?.trim(),
    name      : row[1]?.trim(),
    volume    : parseInt(row[2]?.replace(/,/g,'')) || 0,
    close     : parseFloat(row[7]?.replace(/,/g,'')) || 0,
    changeSign: row[8]?.trim() || '',  // + or -
    changePts : parseFloat(row[9]?.replace(/,/g,'')) || 0,
  })).filter(s => s.code && s.close > 0).map(s => {
    const change    = s.changeSign === '-' ? -s.changePts : s.changePts;
    const prev      = s.close - change;
    const changePct = prev > 0 ? +((change / prev) * 100).toFixed(2) : 0;
    return { ...s, change: +change.toFixed(2), changePct };
  });

  return json({ stocks, date, ts: Date.now() });
}

// ── Yahoo Finance（美股 + 匯率 + 商品）─────────────────────────
// 用法: ?type=yahoo&symbols=^GSPC,^IXIC,^DJI,^SOX,USDTWD=X,CL=F,GC=F,^VIX,^TNX
async function handleYahoo(url) {
  const symbols = url.searchParams.get('symbols') || '^GSPC,^IXIC,^DJI,USDTWD=X';
  const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,shortName`;

  const res  = await fetch(yahooUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    }
  });
  const data = await res.json();
  const result = {};
  (data.quoteResponse?.result || []).forEach(q => {
    result[q.symbol] = {
      name      : q.shortName || q.symbol,
      price     : +(q.regularMarketPrice || 0).toFixed(2),
      change    : +(q.regularMarketChange || 0).toFixed(2),
      changePct : +(q.regularMarketChangePercent || 0).toFixed(2),
      prev      : +(q.regularMarketPreviousClose || 0).toFixed(2),
    };
  });
  return json({ result, ts: Date.now() });
}

// ── RSS 新聞（中央社、經濟日報等）─────────────────────────────
// 用法: ?type=rss&feed=cnyes  (cnyes | udn | chinatimes)
async function handleRSS(url) {
  const feed = url.searchParams.get('feed') || 'cnyes';
  const feeds = {
    cnyes     : 'https://feeds.feedburner.com/rsscnyes_cat_tw_stock',
    udn       : 'https://udn.com/rssfeed/news/2/6641?ch=news',
    chinatimes: 'https://www.chinatimes.com/rss/stock.xml',
    moneydj   : 'https://www.moneydj.com/rss/news.xml',
  };
  const rssUrl = feeds[feed];
  if (!rssUrl) return json({ error: 'Unknown feed' }, 400);

  const res  = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, text/xml' }
  });
  const xml  = await res.text();

  // 簡易 XML 解析（Worker 環境無 DOMParser，手動抓）
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const block = match[1];
    const title = stripTag(block, 'title');
    const link  = stripTag(block, 'link');
    const desc  = stripHtml(stripTag(block, 'description')).slice(0, 150);
    const pubDate = stripTag(block, 'pubDate');
    if (title) items.push({ title, link, desc, pubDate, source: feed });
    if (items.length >= 10) break;
  }
  return json({ items, feed, ts: Date.now() });
}

// ── 工具函式 ───────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function stripTag(str, tag) {
  const m = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return (m?.[1] || m?.[2] || '').trim();
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function prevTradingDay(dateStr) {
  const d = new Date(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
