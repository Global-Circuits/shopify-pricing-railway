// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const csv = require('csv-parse/sync');
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());

// --- Config via env ---
const SHOP_DOMAIN = process.env.SHOP_DOMAIN; // example: myshop.myshopify.com
const SHOP_API_KEY = process.env.SHOP_API_KEY;
const SHOP_API_PASSWORD = process.env.SHOP_API_PASSWORD;
const PRINTIFY_TOKEN = process.env.PRINTIFY_TOKEN; // optional
const PRINTIFY_SHOP_ID = process.env.PRINTIFY_SHOP_ID; // optional
const ROUND_MODE = process.env.ROUND_MODE || 'none'; // none | .99 | .95 | whole
const SCHEDULE = process.env.SCHEDULE || '0 * * * *'; // cron (UTC) default hourly
const PORT = process.env.PORT || 3000;
const ALIEXPRESS_CSV_PATH = process.env.ALIEXPRESS_CSV_PATH || './aliexpress_costs.csv';

// --- Constants ---
const SHOP_BASE = `https://${SHOP_API_KEY}:${SHOP_API_PASSWORD}@${SHOP_DOMAIN}/admin/api/2024-10`;
// Printify base
const PRINTIFY_BASE = 'https://api.printify.com/v1';

// --- Rounding helpers ---
function roundToTwo(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function applyRounding(priceNum) {
  if (ROUND_MODE === 'none' || !ROUND_MODE) return roundToTwo(priceNum);
  if (ROUND_MODE === '.99') {
    const nextWhole = Math.ceil(priceNum);
    return roundToTwo(nextWhole - 0.01);
  }
  if (ROUND_MODE === '.95') {
    const whole = Math.floor(priceNum);
    const candidate1 = whole + 0.95;
    const candidate2 = whole + 1.95;
    const diff1 = Math.abs(candidate1 - priceNum);
    const diff2 = Math.abs(candidate2 - priceNum);
    return roundToTwo(diff1 <= diff2 ? candidate1 : candidate2);
  }
  if (ROUND_MODE === 'whole') {
    return roundToTwo(Math.round(priceNum));
  }
  return roundToTwo(priceNum);
}

// --- AliExpress CSV loader ---
let aliexpressCostBySku = {};
function loadAliExpressCSV() {
  try {
    if (!fs.existsSync(ALIEXPRESS_CSV_PATH)) {
      console.warn('AliExpress CSV not found at', ALIEXPRESS_CSV_PATH);
      aliexpressCostBySku = {};
      return;
    }
    const content = fs.readFileSync(ALIEXPRESS_CSV_PATH, 'utf8');
    const records = csv.parse(content, { columns: true, skip_empty_lines: true });
    const map = {};
    for (const r of records) {
      const sku = (r.sku || r.SKU || '').trim();
      const cost = parseFloat(r.cost || r.cost_usd || r.price || r.price_usd || '0');
      if (sku) map[sku] = isNaN(cost) ? 0 : cost;
    }
    aliexpressCostBySku = map;
    console.log('Loaded', Object.keys(map).length, 'AliExpress SKUs from CSV');
  } catch (err) {
    console.error('Error loading AliExpress CSV:', err.message);
    aliexpressCostBySku = {};
  }
}
loadAliExpressCSV();
app.post('/refresh-aliexpress-csv', (req, res) => {
  loadAliExpressCSV();
  res.json({ ok: true, loaded: Object.keys(aliexpressCostBySku).length });
});

// --- Printify lookup by SKU (best-effort) ---
async function getPrintifyVariantCostBySku(sku) {
  if (!PRINTIFY_TOKEN || !PRINTIFY_SHOP_ID) return 0;
  try {
    const perPage = 50;
    let page = 1;
    while (true) {
      const url = `${PRINTIFY_BASE}/shops/${PRINTIFY_SHOP_ID}/products.json?page=${page}&limit=${perPage}`;
      const resp = await axios.get(url, { headers: { Authorization: `Bearer ${PRINTIFY_TOKEN}` } });
      const list = resp.data.data || resp.data || [];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const p of list) {
        if (!p || !p.variants) continue;
        for (const v of p.variants) {
          const vSku = (v.sku || v.offer_id || '').trim();
          if (!vSku) continue;
          if (vSku === sku) {
            // common fields where cost/price may exist
            const possible = [v.price, v.retail_price, v.default_price, v.variant_price];
            for (const pval of possible) {
              if (pval && !isNaN(parseFloat(pval))) return parseFloat(pval);
            }
            return 0;
          }
        }
      }
      if (list.length < perPage) break;
      page++;
    }
    return 0;
  } catch (err) {
    console.error('Printify fetch error for SKU', sku, err.message);
    return 0;
  }
}

// --- Shopify helpers ---
async function fetchAllShopifyProducts() {
  const results = [];
  let endpoint = `${SHOP_BASE}/products.json?limit=250`;
  try {
    while (endpoint) {
      const resp = await axios.get(endpoint);
      const body = resp.data;
      const products = body.products || [];
      results.push(...products);
      const link = resp.headers.link;
      if (link && link.includes('rel="next"')) {
        const match = link.match(/<([^>]+)>;\s*rel="next"/);
        endpoint = match ? match[1] : null;
      } else {
        endpoint = null;
      }
    }
  } catch (err) {
    console.error('Shopify fetch products error:', err.message);
  }
  return results;
}

async function updateShopifyVariantPrice(variantId, price) {
  const url = `${SHOP_BASE}/variants/${variantId}.json`;
  try {
    const body = { variant: { id: variantId, price: price.toFixed(2) } };
    await axios.put(url, body);
    return true;
  } catch (err) {
    console.error(`Failed updating variant ${variantId}:`, err.response?.data || err.message);
    return false;
  }
}

// --- Price compute for 1% profit ---
function computePriceFromCost(cost) {
  // Formula for 1% profit with 2.9% fee + $0.30
  // cost + 0.029P + 0.30 + 0.01P = P  =>  P = (cost + 0.30) / (1 - 0.039) = (cost + 0.30) / 0.961
  const P = (parseFloat(cost) + 0.30) / 0.961;
  return applyRounding(P);
}

// --- Main job ---
async function runPricingJob() {
  console.log('Starting pricing job at', new Date().toISOString());
  loadAliExpressCSV();
  const products = await fetchAllShopifyProducts();
  console.log('Fetched', products.length, 'products from Shopify');

  let updated = 0, skipped = 0, errors = 0;

  for (const p of products) {
    const vendor = (p.vendor || '').toLowerCase();
    for (const v of p.variants || []) {
      try {
        const sku = (v.sku || '').trim();
        let supplierCost = 0;

        // Identify supplier: treat vendor including 'printify' as Printify; otherwise AliExpress CSV
        if (vendor.includes('printify') || (p.title || '').toLowerCase().includes('printify')) {
          supplierCost = await getPrintifyVariantCostBySku(sku);
        } else {
          supplierCost = aliexpressCostBySku[sku] || 0;
        }

        if (!supplierCost || supplierCost <= 0) {
          skipped++;
          continue;
        }

        const newPrice = computePriceFromCost(supplierCost);
        const currentPrice = parseFloat(v.price || '0');

        if (Math.abs(currentPrice - newPrice) > 0.009) {
          const ok = await updateShopifyVariantPrice(v.id, newPrice);
          if (ok) updated++; else errors++;
        } else {
          skipped++;
        }

      } catch (err) {
        console.error('Error processing variant', v?.id, err.message);
        errors++;
      }
    }
  }

  console.log(`Pricing job complete — updated: ${updated}, skipped: ${skipped}, errors: ${errors}`);
  return { updated, skipped, errors };
}

// Manual trigger
app.post('/run-job', async (req, res) => {
  try {
    const result = await runPricingJob();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// Schedule using cron in-process (Railway may restart, use Railway cron for reliability)
if (SCHEDULE) {
  cron.schedule(SCHEDULE, () => {
    runPricingJob().catch(err => console.error('Scheduled job error:', err));
  }, { timezone: 'UTC' });
}

const server = app.listen(PORT, () => {
  console.log(`Pricing app listening on ${PORT}`);
});

module.exports = server;
