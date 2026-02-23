/**
 * 台股智析 · Cloudflare Worker Proxy v2
 * 修正：RSS連結解析、Yahoo多重備援、新增三大法人買賣超
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url  = new URL(request.url);
    const type = url.searchParams.get('type');
    try {
      switch (type) {
        case 'twse_stock':    return await handleTWSEStock(url);
        case 'twse_index':    return await handleTWSEIndex();
        case 'twse_movers':   return await handleTWSEMovers(url);
        case 'yahoo':         return await handleYahoo(url);
        case 'rss':           return await handleRSS(url);
        case 'institutional': return await handleInstitutional(url);
        default:
          return json({ error: 'Unknown type', available: ['twse_stock','twse_index','twse_movers','yahoo','rss','institutional'] }, 400);
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ── TWSE 個股即時行情 ──────────────────────────────────────────
async function handleTWSEStock(url) {
  const codes = url.searchParams.get('codes') || '';
  const exCh  = codes.split(',').map(c => `tse_${c.trim()}.tw`).join('|');
  const res   = await fetch(
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`,
    { headers: { 'Referer': 'https://mis.twse.com.tw/' } }
  );
  const data   = await res.json();
  const stocks = {};
  (data.msgArray || []).forEach(item => {
    const code      = item.c;
    const price     = parseFloat(item.z) || parseFloat(item.y) || 0;
    const prev      = parseFloat(item.y) || 0;
    const change    = +(price - prev).toFixed(2);
    const changePct = prev > 0 ? +((change / prev) * 100).toFixed(2) : 0;
    stocks[code]    = {
      name: item.n || code, price, change, changePct,
      open: parseFloat(item.o)||0, high: parseFloat(item.h)||0,
      low:  parseFloat(item.l)||0, prev, volume: parseInt(item.v)||0, time: item.t||'',
    };
  });
  return json({ stocks, ts: Date.now() });
}

// ── TWSE 大盤 ─────────────────────────────────────────────────
async function handleTWSEIndex() {
  const res  = await fetch(
    'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0',
    { headers: { 'Referer': 'https://mis.twse.com.tw/' } }
  );
  const data = await res.json();
  const item = data.msgArray?.[0];
  if (!item) return json({ error: 'No index data' }, 503);
  const price     = parseFloat(item.z) || parseFloat(item.y) || 0;
  const prev      = parseFloat(item.y) || 0;
  const change    = +(price - prev).toFixed(2);
  const changePct = prev > 0 ? +((change / prev) * 100).toFixed(2) : 0;
  return json({ price, prev, change, changePct, time: item.t, ts: Date.now() });
}

// ── TWSE 盤後成交 ──────────────────────────────────────────────
async function handleTWSEMovers(url) {
  let date = url.searchParams.get('date') || todayStr();
  const fetch1 = async (d) => {
    const r = await fetch(
      `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date=${d}&response=json`,
      { headers: { 'Referer': 'https://www.twse.com.tw/' } }
    );
    return r.json();
  };
  let data = await fetch1(date);
  if (!data.data || data.stat !== 'OK') { date = prevTradingDay(date); data = await fetch1(date); }
  if (!data.data) return json({ error: 'No movers data', date }, 503);
  const stocks = data.data.map(row => {
    const code  = row[0]?.trim();
    const close = parseFloat(row[7]?.replace(/,/g,'')) || 0;
    const sign  = row[8]?.trim();
    const pts   = parseFloat(row[9]?.replace(/,/g,'')) || 0;
    const change = sign === '-' ? -pts : pts;
    const prev   = close - change;
    return { code, name: row[1]?.trim(), volume: parseInt(row[2]?.replace(/,/g,''))||0,
      close, change: +change.toFixed(2), changePct: prev>0 ? +((change/prev)*100).toFixed(2):0 };
  }).filter(s => s.code && s.close > 0);
  return json({ stocks, date, ts: Date.now() });
}

// ── Yahoo Finance（多重備援，修正問題1）──────────────────────
async function handleYahoo(url) {
  const symbols = url.searchParams.get('symbols') || '^GSPC,^IXIC,^DJI,USDTWD=X';
  const fields  = 'regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,shortName';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // 依序嘗試三個端點，哪個通就用哪個
  const endpoints = [
    `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=${fields}`,
    `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=${fields}`,
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=${fields}`,
  ];

  let quotes = null;
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { headers });
      if (!r.ok) continue;
      const raw = await r.json();
      // v8 和 v7 格式都支援
      const arr = raw.quoteResponse?.result || [];
      if (arr.length > 0) { quotes = arr; break; }
    } catch(_) { continue; }
  }

  if (!quotes) return json({ error: 'All Yahoo endpoints failed' }, 503);

  const result = {};
  quotes.forEach(q => {
    result[q.symbol] = {
      name     : q.shortName || q.symbol,
      price    : +(q.regularMarketPrice             || 0).toFixed(2),
      change   : +(q.regularMarketChange            || 0).toFixed(2),
      changePct: +(q.regularMarketChangePercent     || 0).toFixed(2),
      prev     : +(q.regularMarketPreviousClose     || 0).toFixed(2),
    };
  });
  return json({ result, ts: Date.now() });
}

// ── RSS 新聞（修正連結解析，修正問題2）───────────────────────
async function handleRSS(url) {
  const feed  = url.searchParams.get('feed') || 'cnyes';
  const feeds = {
    cnyes     : 'https://feeds.feedburner.com/rsscnyes_cat_tw_stock',
    udn       : 'https://udn.com/rssfeed/news/2/6641?ch=news',
    chinatimes: 'https://www.chinatimes.com/rss/stock.xml',
    moneydj   : 'https://www.moneydj.com/rss/news.xml',
  };
  const rssUrl = feeds[feed];
  if (!rssUrl) return json({ error: 'Unknown feed' }, 400);

  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, text/xml' },
  });
  const xml   = await res.text();
  const items = [];

  for (const match of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block   = match[1];
    const title   = getCDATA(block, 'title');
    const desc    = stripHtml(getCDATA(block, 'description')).slice(0, 160);
    const pubDate = getCDATA(block, 'pubDate');

    // 連結解析：feedburner origLink > <link> CDATA > <link> 純文字 > guid
    let link =
      getAttr(block, 'feedburner:origLink') ||
      getCDATA(block, 'link') ||
      getRawLink(block)       ||
      getCDATA(block, 'guid') || '';

    link = link.replace(/\s/g, '').trim();
    if (!link.startsWith('http')) link = '';

    if (title) items.push({ title, link, desc, pubDate, source: feed });
    if (items.length >= 12) break;
  }
  return json({ items, feed, ts: Date.now() });
}

// ── 三大法人買賣超（新功能，修正問題5）──────────────────────
async function handleInstitutional(url) {
  let date = url.searchParams.get('date') || todayStr();

  const fetch1 = async (d) => {
    const r = await fetch(
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${d}&selectType=ALL&response=json`,
      { headers: { 'Referer': 'https://www.twse.com.tw/' } }
    );
    return r.json();
  };

  let data = await fetch1(date);
  if (!data.data || data.stat !== 'OK') {
    date = prevTradingDay(date);
    data = await fetch1(date);
  }
  if (!data.data) return json({ error: 'No institutional data', date }, 503);

  // 欄位：[代號][名稱][外資買][外資賣][外資淨][投信買][投信賣][投信淨][自營買][自營賣][自營淨][三大合計]
  const stocks = data.data.map(row => ({
    code      : row[0]?.trim(),
    name      : row[1]?.trim(),
    foreignNet: parseInt(row[4]?.replace(/,/g,''))  || 0,
    trustNet  : parseInt(row[7]?.replace(/,/g,''))  || 0,
    dealerNet : parseInt(row[10]?.replace(/,/g,'')) || 0,
    totalNet  : parseInt(row[11]?.replace(/,/g,'')) || 0,
  })).filter(s => s.code && /^\d{4,5}$/.test(s.code));

  const sorted      = [...stocks].sort((a,b) => b.foreignNet - a.foreignNet);
  const topBuy      = sorted.slice(0, 10);
  const topSell     = sorted.slice(-10).reverse();
  const topTotal    = [...stocks].sort((a,b) => b.totalNet - a.totalNet).slice(0, 10);
  const totalNetBuy = stocks.filter(s => s.foreignNet > 0).reduce((a,b) => a + b.foreignNet, 0);
  const totalNetSell= stocks.filter(s => s.foreignNet < 0).reduce((a,b) => a + b.foreignNet, 0);

  return json({ topBuy, topSell, topTotal, totalNetBuy, totalNetSell, date, ts: Date.now() });
}

// ── 工具函式 ───────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

// CDATA 或純文字都能抓
function getCDATA(str, tag) {
  let m = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
  if (m) return m[1].trim();
  m = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripHtml(m[1]).trim() : '';
}

// 抓 RSS <link> 純文字（它不在標籤對之間，而是在 <link/> 後面）
function getRawLink(block) {
  // 有些 RSS 的 link 格式是：<link>\nhttps://...\n</link> 或 單行
  const m = block.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i);
  return m ? m[1] : '';
}

// 抓 XML 屬性值
function getAttr(str, attr) {
  const m = str.match(new RegExp(`${attr}="([^"]+)"`));
  return m ? m[1].trim() : '';
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g,'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&nbsp;/g,' ').replace(/&#\d+;/g,'').replace(/&[a-z]+;/g,' ').trim();
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function prevTradingDay(dateStr) {
  const d = new Date(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`);
  d.setDate(d.getDate()-1);
  while (d.getDay()===0||d.getDay()===6) d.setDate(d.getDate()-1);
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
