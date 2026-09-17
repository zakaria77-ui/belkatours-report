#!/usr/bin/env node
/**
 * generate-report.mjs
 * ---------------------------------------------------------------
 * Fetches Meta Marketing API data for one ad account and writes a
 * static, token-free "index.html" client report (same look as the
 * "Rapport client" export button in meta-ads-dashboard.html).
 *
 * Run by .github/workflows/update-report.yml on a schedule. Reads
 * everything it needs from environment variables so no secret is
 * ever written to disk or to the generated page:
 *
 *   META_ACCESS_TOKEN   (required) - System User token, ads_read
 *   AD_ACCOUNT_ID       (required) - "act_123..." or "123..."
 *   API_VERSION         (optional) - default "v26.0"
 *   DATE_PRESET         (optional) - default "last_30d"
 *   AGENCY_NAME         (optional) - default "Kaylest Agency"
 *
 * Output: writes ./index.html in the current working directory.
 * ---------------------------------------------------------------
 */

const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCOUNT_RAW = process.env.AD_ACCOUNT_ID;
const API_VERSION = process.env.API_VERSION || "v26.0";
const DATE_PRESET = process.env.DATE_PRESET || "last_30d";
const AGENCY_NAME = process.env.AGENCY_NAME || "Kaylest Agency";
// Optional: force an exact date range instead of DATE_PRESET (useful to
// test against a period with known activity, e.g. an older campaign).
const RANGE_SINCE = process.env.RANGE_SINCE || "";
const RANGE_UNTIL = process.env.RANGE_UNTIL || "";
const USE_CUSTOM_RANGE = !!(RANGE_SINCE && RANGE_UNTIL);

if (!TOKEN || !ACCOUNT_RAW) {
  console.error("Missing META_ACCESS_TOKEN or AD_ACCOUNT_ID environment variable.");
  process.exit(1);
}

const ACCOUNT_ID = ACCOUNT_RAW.indexOf("act_") === 0 ? ACCOUNT_RAW : "act_" + ACCOUNT_RAW;

const RANGE_LABELS = {
  today: "Aujourd'hui", yesterday: "Hier", last_7d: "7 derniers jours",
  last_14d: "14 derniers jours", last_30d: "30 derniers jours", last_90d: "90 derniers jours",
  this_month: "Ce mois-ci", last_month: "Mois dernier", this_year: "Cette année", last_year: "Année dernière"
};

// ---------------------------------------------------------------
// Graph API helpers
// ---------------------------------------------------------------
function graphURL(path, params) {
  const base = "https://graph.facebook.com/" + API_VERSION + "/" + path;
  const qs = Object.keys(params).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
  return base + "?" + qs;
}

async function graphGet(path, params) {
  const url = graphURL(path, Object.assign({}, params, { access_token: TOKEN }));
  const res = await fetch(url);
  const json = await res.json().catch(() => { throw new Error("Réponse invalide de l'API Meta (code " + res.status + ")."); });
  if (json && json.error) throw new Error(json.error.message || "Erreur API Meta.");
  return json;
}

async function graphGetAllPages(path, params, maxPages = 10) {
  let out = [];
  let json = await graphGet(path, params);
  out = out.concat(json.data || []);
  let n = 1;
  while (json.paging && json.paging.next && n < maxPages) {
    const res = await fetch(json.paging.next);
    json = await res.json();
    if (json && json.error) throw new Error(json.error.message || "Erreur API Meta.");
    out = out.concat(json.data || []);
    n++;
  }
  return out;
}

// ---------------------------------------------------------------
// Formatting (mirrors meta-ads-dashboard.html exactly)
// ---------------------------------------------------------------
let currency = "USD";
const numFmt = new Intl.NumberFormat("fr-FR");
function money(v) {
  try { return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 2 }).format(v || 0); }
  catch (e) { return numFmt.format(v || 0) + " " + currency; }
}
function pct(v) { return numFmt.format(Math.round((v || 0) * 100) / 100) + " %"; }
function num(v) { return numFmt.format(Math.round((v || 0) * 100) / 100); }

const ACTION_LABELS = {
  purchase: "Achats", omni_purchase: "Achats",
  lead: "Leads", offsite_conversion_fb_pixel_lead: "Leads",
  complete_registration: "Inscriptions complètes",
  add_to_cart: "Ajouts au panier",
  initiate_checkout: "Paiements initiés",
  link_click: "Clics sur le lien",
  landing_page_view: "Vues de page de destination",
  view_content: "Vues de contenu",
  add_payment_info: "Infos de paiement ajoutées",
  messaging_conversation_started_7d: "Conversations démarrées",
  post_engagement: "Interactions avec la publication",
  page_engagement: "Interactions avec la page",
  like: "J'aime",
  comment: "Commentaires"
};
function actionLabel(type) { return ACTION_LABELS[type] || type.replace(/_/g, " "); }

function actionsToMap(actions) {
  const m = {};
  (actions || []).forEach(a => { m[a.action_type] = parseFloat(a.value) || 0; });
  return m;
}

function pickPrimaryActionType(actionsMap) {
  const priority = ["purchase", "omni_purchase", "lead", "offsite_conversion_fb_pixel_lead", "complete_registration", "add_to_cart", "initiate_checkout", "link_click"];
  for (const p of priority) if (actionsMap[p]) return p;
  const keys = Object.keys(actionsMap);
  return keys.length ? keys[0] : null;
}

// ---------------------------------------------------------------
// SVG charts — static string output (no hover JS: this is a frozen
// snapshot page, exactly what the "Rapport client" export produces)
// ---------------------------------------------------------------
const COLOR_SPEND = "#2a78d6", COLOR_CONV = "#1baf7a", COLOR_GRID = "#e1e0d9", COLOR_MUTED = "#898781", COLOR_SURFACE = "#fcfcfb";

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}
function fmtDate(iso) { const p = iso.split("-"); return p[2] + "/" + p[1]; }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function axesSVG(W, H, pad, maxV, yFmt) {
  let s = "";
  [0, .5, 1].forEach(t => {
    const y = H - pad.b - t * (H - pad.t - pad.b);
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="${COLOR_GRID}" stroke-width="1"/>`;
    s += `<text x="${pad.l - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${COLOR_MUTED}">${esc(yFmt(t * maxV))}</text>`;
  });
  return s;
}
function xLabelsSVG(xsFn, dates, H, pad) {
  let s = "";
  const n = dates.length;
  const everyN = Math.max(1, Math.ceil(n / 6));
  dates.forEach((d, i) => {
    if (i % everyN !== 0 && i !== n - 1) return;
    const anchor = i === 0 ? "start" : (i === n - 1 ? "end" : "middle");
    s += `<text x="${xsFn(i)}" y="${H - 4}" text-anchor="${anchor}" font-size="10" fill="${COLOR_MUTED}">${esc(fmtDate(d))}</text>`;
  });
  return s;
}

function lineChartSVG(dates, values, color, yFmt) {
  const W = 400, H = 220, pad = { l: 38, r: 10, t: 12, b: 20 };
  const maxV = niceMax(Math.max(...values, 0) * 1.15);
  const n = values.length;
  const xs = i => n <= 1 ? pad.l : pad.l + i * ((W - pad.l - pad.r) / (n - 1));
  const ys = v => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
  let body = axesSVG(W, H, pad, maxV, yFmt) + xLabelsSVG(xs, dates, H, pad);
  if (n) {
    const linePts = values.map((v, i) => xs(i) + "," + ys(v)).join(" ");
    const areaPts = "M " + xs(0) + "," + ys(0) + " L " + values.map((v, i) => xs(i) + "," + ys(v)).join(" L ") + " L " + xs(n - 1) + "," + ys(0) + " Z";
    const gradId = "grad-" + Math.random().toString(36).slice(2);
    body += `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.18"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
    body += `<path d="${areaPts}" fill="url(#${gradId})" stroke="none"/>`;
    body += `<polyline points="${linePts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    const lastX = xs(n - 1), lastY = ys(values[n - 1]);
    body += `<circle cx="${lastX}" cy="${lastY}" r="4" fill="${color}" stroke="${COLOR_SURFACE}" stroke-width="2"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g>${body}</g></svg>`;
}

function barChartSVG(dates, values, color, yFmt) {
  const W = 400, H = 220, pad = { l: 34, r: 10, t: 12, b: 20 };
  const maxV = niceMax(Math.max(...values, 0) * 1.15);
  const n = values.length;
  const bandW = n ? (W - pad.l - pad.r) / n : 0;
  const barW = Math.max(2, Math.min(22, bandW * 0.55));
  const ys = v => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
  let body = axesSVG(W, H, pad, maxV, yFmt) + xLabelsSVG(i => pad.l + i * bandW + bandW / 2, dates, H, pad);
  values.forEach((v, i) => {
    const cx = pad.l + i * bandW + bandW / 2;
    const y = ys(v), h = Math.max(0, H - pad.b - y);
    body += `<rect x="${cx - barW / 2}" y="${h > 0 ? y : H - pad.b}" width="${barW}" height="${Math.max(h, 0)}" rx="4" ry="4" fill="${color}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g>${body}</g></svg>`;
}

// ---------------------------------------------------------------
// KPI tiles / tables (mirrors renderKPIs / renderConversionsTable /
// buildCmpRows / cmpRowHTML in meta-ads-dashboard.html)
// ---------------------------------------------------------------
function kpiGridHTML(account, primaryType, primaryLabel) {
  const actions = actionsToMap(account.actions);
  const spend = parseFloat(account.spend) || 0;
  const primaryCount = primaryType ? (actions[primaryType] || 0) : 0;
  const cpa = primaryCount ? spend / primaryCount : null;

  let roas = null;
  if (account.purchase_roas && account.purchase_roas.length) {
    roas = parseFloat(account.purchase_roas[0].value);
  } else {
    const values = actionsToMap(account.action_values || []);
    if (values.purchase || values.omni_purchase) roas = (values.purchase || values.omni_purchase) / (spend || 1);
  }

  const tiles = [
    { label: "Dépense", value: money(spend) },
    { label: "CPA (" + primaryLabel.toLowerCase() + ")", value: cpa != null ? money(cpa) : "—" },
    { label: "ROAS", value: roas != null ? (num(roas) + "x") : "—" },
    { label: "Impressions", value: num(account.impressions) },
    { label: "Reach", value: num(account.reach) },
    { label: "CTR", value: pct(account.ctr) },
    { label: "CPM", value: money(account.cpm) },
    { label: "Clics", value: num(account.clicks) }
  ];
  return tiles.map(t => `<div class="kpi"><span class="label">${esc(t.label)}</span><span class="value">${esc(t.value)}</span></div>`).join("");
}

function conversionsTableHTML(account) {
  const actions = actionsToMap(account.actions);
  const values = actionsToMap(account.action_values || []);
  const spend = parseFloat(account.spend) || 0;
  const rows = Object.keys(actions)
    .filter(k => !/^page_engagement$|^post_engagement$/.test(k) || Object.keys(actions).length < 3)
    .sort((a, b) => actions[b] - actions[a])
    .slice(0, 12);

  if (!rows.length) {
    return { tbody: "", empty: true };
  }
  const tbody = rows.map(type => {
    const count = actions[type];
    const cost = count ? spend / count : null;
    const val = values[type];
    return "<tr>" +
      "<td class='name'>" + esc(actionLabel(type)) + "</td>" +
      "<td class='num'>" + num(count) + "</td>" +
      "<td class='num'>" + (cost != null ? money(cost) : "—") + "</td>" +
      "<td class='num'>" + (val != null ? money(val) : "—") + "</td>" +
      "</tr>";
  }).join("");
  return { tbody, empty: false };
}

function buildCmpRows(raw, nameField, primaryType) {
  return raw.map(r => {
    const actions = actionsToMap(r.actions);
    const conversions = primaryType ? (actions[primaryType] || 0) : 0;
    const spend = parseFloat(r.spend) || 0;
    let roas = null;
    if (r.purchase_roas && r.purchase_roas.length) roas = parseFloat(r.purchase_roas[0].value);
    return {
      name: r[nameField] || "(sans nom)",
      spend, impressions: parseFloat(r.impressions) || 0, reach: parseFloat(r.reach) || 0,
      ctr: parseFloat(r.ctr) || 0, cpm: parseFloat(r.cpm) || 0, conversions,
      cpa: conversions ? spend / conversions : null, roas
    };
  }).sort((a, b) => b.spend - a.spend);
}

function cmpRowHTML(r) {
  return "<tr>" +
    "<td class='name' title='" + esc(r.name) + "'>" + esc(r.name) + "</td>" +
    "<td class='num'>" + money(r.spend) + "</td>" +
    "<td class='num'>" + num(r.impressions) + "</td>" +
    "<td class='num'>" + num(r.reach) + "</td>" +
    "<td class='num'>" + pct(r.ctr) + "</td>" +
    "<td class='num'>" + money(r.cpm) + "</td>" +
    "<td class='num'>" + num(r.conversions) + "</td>" +
    "<td class='num'>" + (r.cpa != null ? money(r.cpa) : "—") + "</td>" +
    "<td class='num'>" + (r.roas != null ? (num(r.roas) + "x") : "—") + "</td>" +
    "</tr>";
}

function cmpTableBlock(title, rows) {
  const head = "<thead><tr><th>Nom</th><th class='num'>Dépense</th><th class='num'>Impressions</th><th class='num'>Reach</th><th class='num'>CTR</th><th class='num'>CPM</th><th class='num'>Conversions</th><th class='num'>CPA</th><th class='num'>ROAS</th></tr></thead>";
  const body = rows.length ? rows.map(cmpRowHTML).join("") : "<tr><td colspan='9' style='text-align:center;color:var(--text-muted);padding:18px;'>Rien à afficher.</td></tr>";
  return "<div class='section'><div class='section-head'><h3>" + esc(title) + "</h3></div><div class='card table-scroll'><table>" + head + "<tbody>" + body + "</tbody></table></div></div>";
}

// ---------------------------------------------------------------
// Page shell — same design tokens as meta-ads-dashboard.html
// ---------------------------------------------------------------
const STYLE = `<style>
  :root{
    color-scheme: light;
    --surface-1:      #fcfcfb;
    --page-plane:     #f9f9f7;
    --text-primary:   #0b0b0b;
    --text-secondary: #52514e;
    --text-muted:     #898781;
    --gridline:       #e1e0d9;
    --baseline:       #c3c2b7;
    --border:         rgba(11,11,11,0.10);
    --series-spend:   #2a78d6;
    --series-conv:    #1baf7a;
    --good:           #0ca30c;
    --critical:       #d03b3b;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      color-scheme: dark;
      --surface-1: #1a1a19; --page-plane: #0d0d0d; --text-primary: #ffffff;
      --text-secondary: #c3c2b7; --text-muted: #898781; --gridline: #2c2c2a;
      --baseline: #383835; --border: rgba(255,255,255,0.10);
      --series-spend: #3987e5; --series-conv: #199e70;
    }
  }
  :root[data-theme="dark"]{
    color-scheme: dark;
    --surface-1: #1a1a19; --page-plane: #0d0d0d; --text-primary: #ffffff;
    --text-secondary: #c3c2b7; --text-muted: #898781; --gridline: #2c2c2a;
    --baseline: #383835; --border: rgba(255,255,255,0.10);
    --series-spend: #3987e5; --series-conv: #199e70;
  }
  *{ box-sizing: border-box; }
  html,body{ margin:0; padding:0; }
  body{ background: var(--page-plane); color: var(--text-primary); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 20px 16px 60px; }
  .wrap{ max-width: 1180px; margin: 0 auto; }
  header.top{ margin-bottom:20px; }
  .brand .eyebrow{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); font-weight:600; }
  .brand h1{ margin:4px 0 2px; font-size:22px; font-weight:700; letter-spacing:-.01em; }
  .brand .acct{ font-size:13px; color:var(--text-secondary); }
  .kpi-grid{ display:grid; grid-template-columns:repeat(2,1fr); gap:2px; background: var(--border); border:1px solid var(--border); border-radius:14px; overflow:hidden; margin-bottom:22px; }
  @media (min-width:560px){ .kpi-grid{ grid-template-columns:repeat(4,1fr); } }
  @media (min-width:900px){ .kpi-grid{ grid-template-columns:repeat(8,1fr); } }
  .kpi{ background: var(--surface-1); padding:16px 16px 14px; display:flex; flex-direction:column; gap:6px; min-height:88px; }
  .kpi .label{ font-size:11.5px; color:var(--text-muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .kpi .value{ font-size:22px; font-weight:700; letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
  .section{ margin-bottom:26px; }
  .section-head{ margin-bottom:10px; }
  .section-head h3{ margin:0; font-size:14px; font-weight:700; }
  .card{ background:var(--surface-1); border:1px solid var(--border); border-radius:14px; padding:18px; }
  .charts-row{ display:grid; grid-template-columns:1fr; gap:14px; }
  @media (min-width:760px){ .charts-row{ grid-template-columns:1.3fr 1fr; } }
  .chart-box{ position:relative; height:220px; }
  .chart-box svg{ display:block; width:100%; height:100%; overflow:visible; }
  .chart-title{ font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:10px; }
  .table-scroll{ overflow-x:auto; }
  table{ width:100%; border-collapse:collapse; font-size:13px; min-width:520px; }
  thead th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--gridline); white-space:nowrap; }
  thead th.num, td.num{ text-align:right; font-variant-numeric:tabular-nums; }
  tbody td{ padding:9px 10px; border-bottom:1px solid var(--gridline); white-space:nowrap; }
  tbody tr:last-child td{ border-bottom:none; }
  td.name{ max-width:220px; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
  .empty-note{ font-size:12.5px; color:var(--text-muted); padding:20px 4px; text-align:center; }
  .footnote{ font-size:11.5px; color:var(--text-muted); text-align:center; margin-top:30px; line-height:1.6; }
</style>`;// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
async function main() {
  const FIELDS_ACCOUNT = "spend,impressions,reach,clicks,ctr,cpm,cpc,actions,action_values,cost_per_action_type,purchase_roas";
  const FIELDS_CAMPAIGN = "campaign_name," + FIELDS_ACCOUNT;
  const FIELDS_ADSET = "adset_name," + FIELDS_ACCOUNT;
  const rangeParams = USE_CUSTOM_RANGE
    ? { time_range: JSON.stringify({ since: RANGE_SINCE, until: RANGE_UNTIL }) }
    : { date_preset: DATE_PRESET };

  const meta = await graphGet(ACCOUNT_ID, { fields: "name,currency,timezone_name" });
  currency = meta.currency || "USD";
  const acctName = meta.name || ACCOUNT_ID;

  const [accountJson, dailyJson, campaignRows, adsetRows] = await Promise.all([
    graphGet(ACCOUNT_ID + "/insights", Object.assign({ fields: FIELDS_ACCOUNT, level: "account" }, rangeParams)),
    graphGet(ACCOUNT_ID + "/insights", Object.assign({ fields: "spend,impressions,actions", level: "account", time_increment: 1 }, rangeParams)),
    graphGetAllPages(ACCOUNT_ID + "/insights", Object.assign({ fields: FIELDS_CAMPAIGN, level: "campaign", limit: 200 }, rangeParams)),
    graphGetAllPages(ACCOUNT_ID + "/insights", Object.assign({ fields: FIELDS_ADSET, level: "adset", limit: 200 }, rangeParams))
  ]);

  const accountRow = (accountJson.data && accountJson.data[0]) || { spend: 0, impressions: 0, reach: 0, clicks: 0, ctr: 0, cpm: 0, actions: [] };
  const dailyRows = (dailyJson.data || []).slice().sort((a, b) => a.date_start.localeCompare(b.date_start));

  const actionsMap = actionsToMap(accountRow.actions);
  const primaryType = pickPrimaryActionType(actionsMap);
  const primaryLabel = primaryType ? actionLabel(primaryType) : "conversions";

  const dates = dailyRows.map(d => d.date_start);
  const spendVals = dailyRows.map(d => parseFloat(d.spend) || 0);
  const convVals = dailyRows.map(d => actionsToMap(d.actions)[primaryType] || 0);

  const spendChart = dates.length ? lineChartSVG(dates, spendVals, COLOR_SPEND, v => money(v)) : "<p class='empty-note'>Pas de données.</p>";
  const convChart = dates.length ? barChartSVG(dates, convVals, COLOR_CONV, v => num(Math.round(v))) : "<p class='empty-note'>Pas de données.</p>";

  const kpiHTML = kpiGridHTML(accountRow, primaryType, primaryLabel);
  const conv = conversionsTableHTML(accountRow);
  const convTableHTML = "<table><thead><tr><th>Type de conversion</th><th class='num'>Nombre</th><th class='num'>Coût / conversion</th><th class='num'>Valeur générée</th></tr></thead><tbody>" + conv.tbody + "</tbody></table>" +
    (conv.empty ? "<p class='empty-note'>Aucune conversion enregistrée sur cette période.</p>" : "");

  const campaignCmp = buildCmpRows(campaignRows, "campaign_name", primaryType);
  const adsetCmp = buildCmpRows(adsetRows, "adset_name", primaryType);

  const rangeLabel = USE_CUSTOM_RANGE ? (RANGE_SINCE + " au " + RANGE_UNTIL) : (RANGE_LABELS[DATE_PRESET] || DATE_PRESET);
  const generatedAt = new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";

  const html = "<!DOCTYPE html>\n<html lang=\"fr\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>" + esc(acctName) + " — Rapport Meta Ads</title>\n" + STYLE + "\n</head>\n<body>\n<div class=\"wrap\">\n" +
    "<header class=\"top\"><div class=\"brand\"><span class=\"eyebrow\">Rapport Meta Ads</span><h1>" + esc(acctName) + "</h1><span class=\"acct\">Période : " + esc(rangeLabel) + " · Généré le " + esc(generatedAt) + "</span></div></header>\n" +
    "<div class=\"kpi-grid\">" + kpiHTML + "</div>\n" +
    "<div class=\"section\"><div class=\"section-head\"><h3>Évolution sur la période</h3></div><div class=\"card\"><div class=\"charts-row\">" +
    "<div><div class=\"chart-title\">Dépense quotidienne</div><div class=\"chart-box\">" + spendChart + "</div></div>" +
    "<div><div class=\"chart-title\">Conversions quotidiennes (" + esc(primaryLabel.toLowerCase()) + ")</div><div class=\"chart-box\">" + convChart + "</div></div>" +
    "</div></div></div>\n" +
    "<div class=\"section\"><div class=\"section-head\"><h3>Détail des conversions</h3></div><div class=\"card table-scroll\">" + convTableHTML + "</div></div>\n" +
    cmpTableBlock("Performance par campagne", campaignCmp) + "\n" +
    cmpTableBlock("Performance par ensemble de publicités", adsetCmp) + "\n" +
    "<p class=\"footnote\">Rapport de performance préparé par " + esc(AGENCY_NAME) + ". Événement de conversion principal suivi : " + esc(primaryLabel) + ". Mis à jour automatiquement plusieurs fois par jour.</p>\n" +
    "</div>\n</body>\n</html>";

  const fs = await import("node:fs/promises");
  await fs.writeFile("index.html", html, "utf8");
  console.log("Wrote index.html (" + html.length + " bytes) for account " + acctName);
}

main().catch(err => {
  console.error("generate-report failed:", err.message || err);
  process.exit(1);
});
