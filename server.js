const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const HOST = "127.0.0.1";
const PORT = 8080;

// Put addresses.txt in same folder as server.js
const ADDRESS_FILE = path.join(__dirname, "addresses.txt");

// Cache TTL for checked results
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Batch size for blockchain.com multiaddr
const MULTIADDR_BATCH = 50;

// In-memory caches
let ADDRESS_LIST = [];
const RESULT_CACHE = new Map();

/* =========================
   LOAD ADDRESS FILE
========================= */
function loadAddresses() {
  const text = fs.readFileSync(ADDRESS_FILE, "utf8");
  const seen = new Set();
  ADDRESS_LIST = text
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean)
    .filter(addr => {
      if (seen.has(addr)) return false;
      seen.add(addr);
      return true;
    });
}

/* =========================
   HELPERS
========================= */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.get(u, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");

      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid JSON: ${url}`));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout: ${url}`));
    });

    req.on("error", reject);
  });
}

function typeInfo(addr) {
  const x = addr.toLowerCase();

  if (addr.startsWith("1")) return ["P2PKH", "None"];
  if (addr.startsWith("3")) return ["P2SH", "Possible"];
  if (x.startsWith("bc1q")) {
    if (x.length < 45) return ["P2WPKH", "None"];
    return ["P2WSH", "Possible"];
  }
  if (x.startsWith("bc1p")) return ["Taproot", "Possible"];

  return ["Unknown", "Unknown"];
}

function fmtBalanceSats(sats) {
  return (sats / 100000000).toFixed(8);
}

function fmtDate(ts) {
  if (!ts || ts <= 0) return "-";
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getCached(addr) {
  const row = RESULT_CACHE.get(addr);
  if (!row) return null;
  if ((Date.now() - row.savedAt) > CACHE_TTL_MS) {
    RESULT_CACHE.delete(addr);
    return null;
  }
  return row;
}

function setCached(addr, row) {
  RESULT_CACHE.set(addr, { ...row, savedAt: Date.now() });
}

/* =========================
   PROVIDERS
========================= */

// Batch provider: blockchain.com multiaddr
async function fetchBlockchainMulti(addresses) {
  if (!addresses.length) return new Map();

  const active = addresses.join("|");
  const url = `https://blockchain.info/multiaddr?active=${encodeURIComponent(active)}&n=1`;

  const data = await fetchJson(url);
  const out = new Map();

  if (Array.isArray(data.addresses)) {
    for (const item of data.addresses) {
      const addr = item.address;
      const balance = item.final_balance || 0;
      const txs = item.n_tx || 0;

      let dateNum = 0;
      if (Array.isArray(data.txs) && data.txs.length > 0) {
        // multiaddr txs are mixed across addresses, so date may be imperfect
        // fallback providers can improve this if needed
      }

      const [type, multi] = typeInfo(addr);

      out.set(addr, {
        addr,
        bal: fmtBalanceSats(balance),
        balNum: balance,
        tx: txs,
        date: fmtDate(dateNum),
        dateNum,
        type,
        multi,
        source: "blockchain.com"
      });
    }
  }

  return out;
}

// Fallback provider: Blockstream
async function fetchBlockstreamOne(addr) {
  const summary = await fetchJson(`https://blockstream.info/api/address/${encodeURIComponent(addr)}`);
  const txs = await fetchJson(`https://blockstream.info/api/address/${encodeURIComponent(addr)}/txs`);

  const balNum =
    (summary.chain_stats?.funded_txo_sum || 0) -
    (summary.chain_stats?.spent_txo_sum || 0);

  const tx =
    (summary.chain_stats?.tx_count || 0) +
    (summary.mempool_stats?.tx_count || 0);

  let dateNum = 0;
  if (Array.isArray(txs)) {
    for (const t of txs) {
      const bt = t?.status?.block_time || 0;
      if (bt > dateNum) dateNum = bt;
    }
  }

  const [type, multi] = typeInfo(addr);

  return {
    addr,
    bal: fmtBalanceSats(balNum),
    balNum,
    tx,
    date: fmtDate(dateNum),
    dateNum,
    type,
    multi,
    source: "blockstream"
  };
}

// Fallback provider: BlockCypher
async function fetchBlockCypherOne(addr) {
  const j = await fetchJson(`https://api.blockcypher.com/v1/btc/main/addrs/${encodeURIComponent(addr)}?limit=1`);

  const balNum = j.final_balance || 0;
  const tx = j.n_tx || 0;

  let dateNum = 0;
  if (Array.isArray(j.txrefs) && j.txrefs.length > 0) {
    const confirmed = j.txrefs[0]?.confirmed;
    if (confirmed) {
      const parsed = Date.parse(confirmed);
      if (!Number.isNaN(parsed)) dateNum = Math.floor(parsed / 1000);
    }
  }

  if (!dateNum && Array.isArray(j.unconfirmed_txrefs) && j.unconfirmed_txrefs.length > 0) {
    const received = j.unconfirmed_txrefs[0]?.received;
    if (received) {
      const parsed = Date.parse(received);
      if (!Number.isNaN(parsed)) dateNum = Math.floor(parsed / 1000);
    }
  }

  const [type, multi] = typeInfo(addr);

  return {
    addr,
    bal: fmtBalanceSats(balNum),
    balNum,
    tx,
    date: fmtDate(dateNum),
    dateNum,
    type,
    multi,
    source: "blockcypher"
  };
}

async function fetchOneWithFallback(addr) {
  try {
    return await fetchBlockstreamOne(addr);
  } catch (_) {
    await sleep(200);
  }

  return await fetchBlockCypherOne(addr);
}

/* =========================
   PAGE CHECKER
========================= */
async function buildPageRows(page, size) {
  const start = (page - 1) * size;
  const end = Math.min(start + size, ADDRESS_LIST.length);
  const addrs = ADDRESS_LIST.slice(start, end);

  // 1) cache hits
  const rows = new Array(addrs.length);
  const uncached = [];

  for (let i = 0; i < addrs.length; i++) {
    const addr = addrs[i];
    const cached = getCached(addr);

    if (cached) {
      rows[i] = cached;
    } else {
      uncached.push({ index: i, addr });
    }
  }

  // 2) batch fetch uncached using multiaddr in chunks
  for (let i = 0; i < uncached.length; i += MULTIADDR_BATCH) {
    const chunk = uncached.slice(i, i + MULTIADDR_BATCH);
    const chunkAddrs = chunk.map(x => x.addr);

    let batchMap = new Map();
    try {
      batchMap = await fetchBlockchainMulti(chunkAddrs);
    } catch (_) {
      batchMap = new Map();
    }

    // fill what batch returned
    const stillMissing = [];

    for (const item of chunk) {
      const row = batchMap.get(item.addr);
      if (row) {
        rows[item.index] = row;
        setCached(item.addr, row);
      } else {
        stillMissing.push(item);
      }
    }

    // 3) fallback only for missing rows
    for (const item of stillMissing) {
      const row = await fetchOneWithFallback(item.addr);
      rows[item.index] = row;
      setCached(item.addr, row);
    }
  }

  return rows;
}

/* =========================
   HTTP SERVER
========================= */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/meta") {
    json(res, 200, {
      total: ADDRESS_LIST.length,
      cacheSize: RESULT_CACHE.size
    });
    return;
  }

  if (url.pathname === "/api/page") {
    try {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const size = Math.max(1, Math.min(100, parseInt(url.searchParams.get("size") || "50", 10)));

      const rows = await buildPageRows(page, size);

      json(res, 200, {
        page,
        size,
        total: ADDRESS_LIST.length,
        rows
      });
    } catch (err) {
      json(res, 500, {
        error: err.message || "server error"
      });
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    text(res, 200, "OK");
    return;
  }

  text(res, 404, "Not found");
});

loadAddresses();
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Loaded addresses: ${ADDRESS_LIST.length}`);
});
