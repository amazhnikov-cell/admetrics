import React, { useState, useMemo, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import Papa from "papaparse";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SOURCES = [
  { id: "yandex", label: "Яндекс Поиск", short: "Поиск", color: "#FC3F1D" },
  { id: "rsya",   label: "Яндекс РСЯ",   short: "РСЯ",   color: "#FF9900" },
  { id: "vk",     label: "VK Ads",        short: "VK",    color: "#2688EB" },
  { id: "tg",     label: "TG Ads",        short: "TG",    color: "#2AABEE" },
  { id: "hh",     label: "HH.ru",         short: "HH",    color: "#F2311D" },
  { id: "avito",  label: "Авито ADS",     short: "Авито", color: "#00AAFF" },
  { id: "mts",    label: "МТС Маркетолог",short: "МТС",   color: "#E30611" },
];

// ─── GOOGLE SHEETS IDs ───────────────────────────────────────────────────────

const SALES_SHEET_ID = "1VGShve258tx95D34alpHzmpiYokV--EfWNTnOkuB9rI";
const AD_SHEET_ID    = "1t5MfqG9gvuVmLdZFbvn_d58KvKPe_vcZyh77e3pU3GE";

function gsCsvUrl(sheetId, sheetName) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

// ─── ТАБЛИЦА ПРОДАЖ (Лиды) ───────────────────────────────────────────────────

const DEMO_STATUSES = new Set([
  "горячий","демонстрация проведена","долгосрочный интерес",
  "ндз 3 раза после демо","не подошли по функционалу","оплата",
  "отказ после демо","отказ после счета","первичное демо проведено",
  "пилот","теплый","тест","тест (бесплатный)","холодный",
]);

// Столбцы листа «Лиды» (0-based)
const SALES_COL = { date: 5, statusLead: 7, statusBitrix: 18, suma: 23, channel: 25 };

function mapChannel(ch) {
  const c  = (ch || "").trim();
  if (!c) return null;
  const lo = c.toLowerCase();
  // Исключаем SEO-трафик
  if (lo.includes("seo"))                       return null;
  // РСЯ — первым, до Яндекса
  if (lo.includes("рся"))                       return "rsya";
  // Любой Яндекс без РСЯ и без SEO
  if (lo.includes("яндекс") || lo.includes("yandex")) return "yandex";
  // VK
  if (lo.includes("vk product"))                return "vk";
  // TG
  if (lo.includes("tg ads"))                    return "tg";
  // HH
  if (lo.includes("рекламный кабинет hh"))      return "hh";
  // Авито
  if (lo.includes("авито"))                     return "avito";
  // МТС
  if (lo.includes("мтс маркетолог") || lo.includes("мтс"))  return "mts";
  return null;
}

// Разбор дат: DD.MM.YYYY | D.M.YYYY | M/D/YYYY | YYYY-MM-DD
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m;
  // ISO 8601: "2026-01-05T00:00:00.000Z" (Apps Script Date → JSON)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD.MM.YYYY или D.M.YYYY
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  // M/D/YYYY или MM/DD/YYYY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0,10);
  return null;
}

function parseNum(s) {
  if (s === null || s === undefined) return 0;
  const str = String(s).trim();
  // Пустая строка или прочерк → 0
  if (!str || str === "-" || str === "–" || str === "—") return 0;
  // Убираем: ₽, %, пробелы (в т.ч. неразрывные), запятые-разделители тысяч
  const cleaned = str
    .replace(/[₽%]/g, "")
    .replace(/[\s\u00a0\u202f]/g, "")  // обычные и неразрывные пробелы
    .replace(/,/g, "");                  // убираем запятые (разделители тысяч)
  if (!cleaned || cleaned === "-" || cleaned === "–") return 0;
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ─── APPS SCRIPT PROXY ───────────────────────────────────────────────────────

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxRfRHOMyJ-e1m25v89qQKhX069giVTxMSRzMlZUBW2tKwWZAnXe_lpjUg6VsSPBOUe/exec";

const AD_SHEET_GIDS = {
  yandex: "1926115906", rsya: "1926115906",
  vk: "649187614", tg: "235319143",
  hh: "975106334", avito: "1703980962", mts: "916506306",
};

function mapDirection(dir) {
  const d = (dir || "").toString().trim().toLowerCase();
  if (d.includes("рся") || d.includes("rsya") || d.includes("yan")) return "rsya";
  if (d.includes("поиск") || d.includes("search")) return "yandex";
  return null;
}

async function fetchAllData() {
  const resp = await fetch(APPS_SCRIPT_URL, { redirect: "follow" });
  if (!resp.ok) throw new Error("Apps Script HTTP " + resp.status);
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error("JSON parse: " + text.slice(0, 120)); }
}

// Парсер для «Яндекс Директ» листа из Код.gs
// Структура: [Дата, Направление, Расход, Показы, Клики, Лиды]
// Строка 0 = заголовок, данные с строки 1
function parseYandexDirectRows(rawRows) {
  const result = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || !r[0]) continue;
    const date = parseDate(String(r[0]));
    const src  = mapDirection(String(r[1] || ""));
    if (!date || !src) continue;
    const spend = parseNum(r[2]);
    const imp   = parseNum(r[3]);
    const clk   = parseNum(r[4]);
    const leads = parseNum(r[5]);
    if (spend === 0 && imp === 0) continue;
    result.push({ date, source: src, spend, salary: 0,
      totalSpend: spend, impressions: imp, clicks: clk, leads });
  }
  return result;
}

// Парсер для шаблонного листа Яндекс (Поиск + РСЯ)
// Структура: [Дата, Направление, Расход, ЗП, Расход+ЗП, Показы, Клики, Лиды, ...]
// Строки 0-3 = мета, данные с строки 4
function parseYandexTemplateRows(rawRows) {
  const result = [];
  for (let i = 4; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || !r[0]) continue;
    const date = parseDate(String(r[0]));
    const src  = mapDirection(String(r[1] || ""));
    if (!date || !src) continue;
    const spend      = parseNum(r[2]);           // C: Расход (каб.)
    const sal        = parseNum(r[3]);           // D: ЗП
    const totalSpend = parseNum(r[4]) || (spend + sal); // E: Расход+ЗП (формула C+D)
    const salary     = Math.max(0, totalSpend - spend); // ЗП = разница
    const imp        = parseNum(r[5]);
    const clk        = parseNum(r[6]);
    const leads      = parseNum(r[7]);
    if (spend === 0 && imp === 0) continue;
    result.push({ date, source: src, spend, salary,
      totalSpend, impressions: imp, clicks: clk, leads });
  }
  return result;
}

// Парсер стандартных листов (VK, TG, HH, Авито, МТС)
// Структура: [Дата, Расход, ЗП, Расход+ЗП, Показы, Клики, Лиды, ...]
// Строки 0-3 = мета, данные с строки 4
function parseStdRows(rawRows, srcId) {
  const result = [];
  for (let i = 4; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || !r[0]) continue;
    const dateStr = String(r[0]);
    if (dateStr.includes("ИТОГО")) continue;
    const date = parseDate(dateStr);
    if (!date) continue;
    const spend = parseNum(r[1]);
    const sal   = parseNum(r[2]);
    const imp   = parseNum(r[4]);
    const clk   = parseNum(r[5]);
    const leads = parseNum(r[6]);
    if (spend === 0 && imp === 0) continue;
    result.push({ date, source: srcId, spend, salary: sal,
      totalSpend: spend + sal, impressions: imp, clicks: clk, leads });
  }
  return result;
}

// Загружает ВСЕ данные за один запрос
async function loadAllData() {
  const raw = await fetchAllData();

  // ── Рекламные данные ──────────────────────────────────────────────────────
  const adLookup = {};
  const merge = (rows) => rows.forEach(r => {
    if (!r.date) return;
    const key = r.date + "__" + r.source;
    if (!adLookup[key]) adLookup[key] = { ...r };
    else ["spend","salary","totalSpend","impressions","clicks","leads"].forEach(k => {
      adLookup[key][k] = (adLookup[key][k]||0) + (r[k]||0);
    });
  });

  // Яндекс: берём метрики из Код.gs листа, ЗП — из шаблона (gid=1926115906)
  // Шаблон всегда читаем для ЗП; если есть Код.gs лист — берём из него show/imp/clk/leads
  if (raw.ad_yandex_direct && raw.ad_yandex_direct.length > 1) {
    // Сначала загружаем шаблон — получаем salary/totalSpend
    if (raw.ad_yandex_rsya) {
      merge(parseYandexTemplateRows(raw.ad_yandex_rsya));
    }
    // Затем мёржим данные из Код.gs — перезаписываем spend/imp/clicks/leads
    const directRows = parseYandexDirectRows(raw.ad_yandex_direct);
    directRows.forEach(r => {
      const key = r.date + "__" + r.source;
      if (!adLookup[key]) {
        adLookup[key] = { ...r };
      } else {
        // Берём spend/imp/clicks/leads из Код.gs, salary/totalSpend из шаблона
        const existingSalary = adLookup[key].salary || 0;
        adLookup[key].spend       = r.spend;
        adLookup[key].impressions = r.impressions;
        adLookup[key].clicks      = r.clicks;
        adLookup[key].leads       = r.leads;
        adLookup[key].salary      = existingSalary;
        adLookup[key].totalSpend  = r.spend + existingSalary;
      }
    });
  } else if (raw.ad_yandex_rsya) {
    merge(parseYandexTemplateRows(raw.ad_yandex_rsya));
  }

  // Остальные источники
  const others = [
    {id:"vk",key:"ad_vk"}, {id:"tg",key:"ad_tg"}, {id:"hh",key:"ad_hh"},
    {id:"avito",key:"ad_avito"}, {id:"mts",key:"ad_mts"},
  ];
  others.forEach(({id,key}) => {
    if (raw[key]) merge(parseStdRows(raw[key], id));
  });

  // ── Данные продаж ─────────────────────────────────────────────────────────
  const salesLookup = {};
  const salesRows   = raw.sales || [];
  const debugChannels = {};   // Z-значение → кол-во оплаченных строк

  for (let i = 1; i < salesRows.length; i++) {
    const r = salesRows[i];
    if (!r || r.length < 26) continue;
    const channel    = String(r[25] || "").trim();
    const dateOplaty = String(r[22] || "").trim();
    const suma       = parseNum(r[23]);
    const statLead   = String(r[7]  || "").trim().toLowerCase();
    const statBit    = String(r[18] || "").trim().toLowerCase();

    // Дебаг: все оплаченные строки (W не пустой + статус оплата)
    if (dateOplaty !== "" && statBit === "оплата") {
      const dbKey = channel || "(пустой)";
      debugChannels[dbKey] = (debugChannels[dbKey] || 0) + 1;
    }

    if (!channel) continue;
    const sourceId = mapChannel(channel);
    if (!sourceId) continue;
    const date = parseDate(String(r[5] || ""));
    if (!date) continue;

    const key = date + "__" + sourceId;
    if (!salesLookup[key]) salesLookup[key] = { qual:0, demo:0, sales:0, revenue:0 };
    if (statLead === "выигрыш")       salesLookup[key].qual++;
    if (DEMO_STATUSES.has(statBit))   salesLookup[key].demo++;
    if (dateOplaty !== "" && statBit === "оплата") {
      salesLookup[key].sales++;
      if (suma > 0) salesLookup[key].revenue += suma;
    }
  }

  return { adLookup, salesLookup, debugChannels };
}

// Обёртки для совместимости с существующим кодом
async function loadAdData() {
  const { adLookup } = await loadAllData();
  return adLookup;
}
async function loadSalesData() {
  const { salesLookup } = await loadAllData();
  return salesLookup;
}

const CAMPAIGNS = {
  yandex: ["Поиск – общие", "Поиск – бренд", "Поиск – конкуренты"],
  rsya:   ["РСЯ – общие", "РСЯ – ретаргет", "РСЯ – look-alike"],
  vk:     ["Ретаргет – тёплые", "Look-alike", "Широкая аудитория"],
  tg:     ["Канал 1 (tech)", "Канал 2 (biz)", "Спонсор"],
  hh:     ["Основной поток", "Брендинг"],
  avito:  ["Продвижение объявл.", "Контекст"],
  mts:    ["Медийная", "Таргетированная"],
};

const CAMP_W = {
  yandex: [0.45, 0.35, 0.20],
  rsya:   [0.50, 0.30, 0.20],
  vk:     [0.40, 0.35, 0.25],
  tg:     [0.45, 0.35, 0.20],
  hh:     [0.60, 0.40],
  avito:  [0.55, 0.45],
  mts:    [0.50, 0.50],
};

const USERS = {
  admin:          { pwd: "admin123",   name: "Администратор",    tabs: ["summary","yandex","rsya","vk","tg","hh","avito","mts"] },
  yandex_partner: { pwd: "yandex123", name: "Партнёр Яндекс Поиск", tabs: ["yandex"] },
  rsya_partner:   { pwd: "rsya123",   name: "Партнёр РСЯ",          tabs: ["rsya"] },
  vk_partner:     { pwd: "vk123",     name: "Партнёр VK",           tabs: ["vk"] },
  tg_partner:     { pwd: "tg123",     name: "Партнёр TG",           tabs: ["tg"] },
  hh_partner:     { pwd: "hh123",     name: "Партнёр HH",           tabs: ["hh"] },
  avito_partner:  { pwd: "avito123",  name: "Партнёр Авито",        tabs: ["avito"] },
  mts_partner:    { pwd: "mts123",    name: "Партнёр МТС",          tabs: ["mts"] },
};

const BASE = {
  yandex: { spend: 45000, imp: 18000, clk: 520,  leads: 6   },
  rsya:   { spend: 32000, imp: 55000, clk: 680,  leads: 5   },
  vk:     { spend: 28000, imp: 22000, clk: 340,  leads: 4   },
  tg:     { spend: 15000, imp: 35000, clk: 210,  leads: 3   },
  hh:     { spend: 12000, imp: 8000,  clk: 160,  leads: 2.5 },
  avito:  { spend: 18000, imp: 14000, clk: 270,  leads: 3.5 },
  mts:    { spend: 22000, imp: 25000, clk: 360,  leads: 4.5 },
};

const SALARY_RATE = 0.22;
const COGS_RATE   = 0.13;
const AVG_PRICE   = 359184;
const TODAY = new Date().toISOString().split("T")[0];  // реальная текущая дата

// ─── DATA GEN ────────────────────────────────────────────────────────────────

function rnd(s) {
  const x = Math.sin(s * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

const RAW = (() => {
  const data = {};
  SOURCES.forEach(({ id }) => {
    const b = BASE[id];
    const rows = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date(TODAY); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split("T")[0];
      const n = (k) => rnd(id.charCodeAt(0) * 100 + i * 7 + k);
      const v = (base, k) => Math.round(base * (0.65 + n(k) * 0.7));
      const spend   = v(b.spend, 1);
      const salary  = Math.round(spend * SALARY_RATE);
      const imp     = v(b.imp, 2);
      const clicks  = v(b.clk, 3);
      const leads   = Math.max(1, v(b.leads, 4));
      const qual    = Math.max(0, Math.round(leads * (0.28 + n(5) * 0.14)));
      const demo    = Math.max(0, Math.round(qual  * (0.45 + n(6) * 0.2)));
      const sales   = Math.max(0, Math.round(demo  * (0.1  + n(7) * 0.15)));
      const revenue = sales * Math.round(AVG_PRICE * (0.85 + n(8) * 0.3));
      const cogs    = Math.round(revenue * COGS_RATE);
      rows.push({
        date: ds, source: id,
        spend, salary, totalSpend: spend + salary,
        impressions: imp, clicks, leads, qual, demo, sales,
        revenue, cogs, grossMargin: revenue - cogs,
      });
    }
    data[id] = rows;
  });
  return data;
})();

// ─── UTILS ───────────────────────────────────────────────────────────────────

const ru      = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(n));
const rubFull = (n) => `${ru(n)} ₽`;
const rubK    = (n) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(2)}M ₽` : n >= 1000 ? `${(n/1000).toFixed(0)}K ₽` : `${Math.round(n)} ₽`;
const pct     = (n) => `${(n * 100).toFixed(1)}%`;
const pct2    = (n) => `${(n * 100).toFixed(2)}%`;

function agg(rows) {
  if (!rows.length) return {};
  const s = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const spend = s("spend"), salary = s("salary"), totalSpend = s("totalSpend");
  const imp = s("impressions"), clicks = s("clicks");
  const leads = s("leads"), qual = s("qual"), demo = s("demo"), sales = s("sales");
  const revenue = s("revenue");
  const cogsPct = COGS_RATE;
  const cogs = Math.round(revenue * cogsPct);
  const grossMargin = revenue - cogs - totalSpend;
  return {
    spend, salary, totalSpend, impressions: imp, clicks,
    leads, qual, demo, sales, revenue, cogs, grossMargin,
    // все рассчитываются автоматически:
    cpm:        imp > 0   ? Math.round((totalSpend / imp) * 1000) : 0,
    ctr:        imp > 0   ? clicks / imp  : 0,
    cpl:        leads > 0 ? Math.round(totalSpend / leads) : 0,
    c1ql:       leads > 0 ? qual / leads  : 0,
    cpql:       qual > 0  ? Math.round(totalSpend / qual)  : 0,
    crQualDemo: qual > 0  ? demo / qual   : 0,
    crDemoSale: demo > 0  ? sales / demo  : 0,
    crQlSale:   qual > 0  ? sales / qual  : 0,
    cac:        sales > 0 ? Math.round(totalSpend / sales) : 0,
    avgPrice:   sales > 0 ? Math.round(revenue / sales)    : 0,
    cogsPct,
  };
}

function filterRows(rows, from, to) {
  return rows.filter(r => r.date >= from && r.date <= to);
}

function addDays(ds, n) {
  const d = new Date(ds); d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

function fmtRange(r) {
  const f = (s) => new Date(s).toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit",year:"2-digit"});
  return `${f(r.from)} – ${f(r.to)}`;
}

// ─── PRESETS ─────────────────────────────────────────────────────────────────

const PRESETS = [
  { id: "yesterday", label: "Вчера"         },
  { id: "week",      label: "Эта неделя"    },
  { id: "month",     label: "Этот месяц"    },
  { id: "prev",      label: "Прошлый месяц" },
  { id: "year",      label: "Этот год"      },
  { id: "lastyear",  label: "Прошлый год"   },
];

function presetRange(p) {
  const now      = new Date();
  const today    = now.toISOString().split("T")[0];
  const y        = now.getFullYear();
  const m        = String(now.getMonth() + 1).padStart(2, "0");
  const prevDate = new Date(y, now.getMonth() - 1, 1);
  const prevY    = prevDate.getFullYear();
  const prevM    = String(prevDate.getMonth() + 1).padStart(2, "0");
  const prevLast = new Date(y, now.getMonth(), 0).toISOString().split("T")[0];

  switch (p) {
    case "yesterday": return { from: addDays(today,-1), to: addDays(today,-1) };
    case "week": {
      const dow = now.getDay();
      return { from: addDays(today, -(dow===0?6:dow-1)), to: today };
    }
    case "month": return { from: `${y}-${m}-01`,     to: today };
    case "prev":  return { from: `${prevY}-${prevM}-01`, to: prevLast };
    case "year":     return { from: `${y}-01-01`,     to: today };
    case "lastyear": return { from: `${y-1}-01-01`,   to: `${y-1}-12-31` };
    default:         return { from: addDays(today,-29), to: today };
  }
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#070C16;--bg1:#0F1520;--bg2:#161D2E;
  --b1:#1E2A3E;--b2:#2A3A55;
  --t1:#E8EDF5;--t2:#8A95A8;--t3:#4A5568;
  --acc:#4F8EF7;--acc2:#3A7AE8;
  --grn:#22C875;--red:#F45050;--ora:#F97316;--yel:#EAB308;--pur:#A78BFA;
  --font:'Onest',sans-serif;--mono:'JetBrains Mono',monospace;
}
html,body{background:var(--bg);color:var(--t1);font-family:var(--font);font-size:13px}
.app{display:flex;min-height:100vh}

/* Sidebar */
.sb{width:220px;min-height:100vh;background:var(--bg1);border-right:1px solid var(--b1);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:100}
.sb-logo{padding:20px 16px 14px;border-bottom:1px solid var(--b1)}
.sb-title{font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--acc)}
.sb-sub{font-size:10px;color:var(--t3);margin-top:2px;text-transform:uppercase;letter-spacing:.06em}
.sb-nav{padding:10px 8px;flex:1;overflow-y:auto}
.sb-section{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);padding:0 8px;margin:14px 0 4px}
.sb-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:12.5px;color:var(--t2);transition:all .15s;margin-bottom:1px}
.sb-item:hover{background:var(--bg2);color:var(--t1)}
.sb-item.act{background:rgba(79,142,247,.13);color:var(--acc)}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sb-user{padding:12px 16px;border-top:1px solid var(--b1)}
.sb-uname{font-size:12px;font-weight:600;margin-bottom:2px}
.sb-urole{font-size:11px;color:var(--t3)}
.sb-sync{margin-top:8px;font-size:10px;padding:7px 9px;border-radius:5px;background:var(--bg2);display:flex;flex-direction:column;gap:4px}
.sync-row{display:flex;align-items:center;gap:5px}
.sync-lbl{color:var(--t3);font-size:9px;text-transform:uppercase;letter-spacing:.06em;width:54px;flex-shrink:0}
.sync-loading{color:var(--yel);font-family:var(--mono);font-size:9px}
.sync-ok{color:var(--grn);font-family:var(--mono);font-size:9px;display:flex;align-items:center;gap:3px}
.sync-err{color:var(--red);font-family:var(--mono);font-size:9px;display:flex;align-items:center;gap:3px}
.sync-btn{background:transparent;border:1px solid currentColor;border-radius:3px;padding:1px 4px;font-size:9px;cursor:pointer;color:inherit;font-family:var(--mono);opacity:.8;line-height:1.2}
.sync-btn:hover{opacity:1}
.sync-hint{font-size:8.5px;color:var(--yel);line-height:1.4;margin-top:2px;font-style:italic}
.sync-errmsg{font-size:8px;color:var(--red);font-family:var(--mono);line-height:1.4;margin-top:2px;word-break:break-all}
.debug-channels{margin-top:3px;max-height:180px;overflow-y:auto;font-size:8px;font-family:var(--mono)}
.debug-row{display:grid;grid-template-columns:22px 36px 1fr;gap:3px;padding:2px 3px;border-radius:2px;line-height:1.4}
.debug-row.unmapped{background:rgba(244,80,80,.08);color:var(--red)}
.debug-row:not(.unmapped){color:var(--t2)}
.debug-cnt{color:var(--yel);text-align:right}
.debug-src{color:var(--acc);overflow:hidden}
.debug-val{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t3)}
.sb-logout{margin-top:8px;width:100%;padding:5px;background:transparent;border:1px solid var(--b2);border-radius:4px;color:var(--t2);font-size:11px;cursor:pointer;font-family:var(--font);transition:all .15s}
.sb-logout:hover{border-color:var(--red);color:var(--red)}
.sb-setup{margin-top:10px;padding-top:10px;border-top:1px solid var(--b1)}
.sb-setup-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-bottom:4px}
.sb-setup-inp{width:100%;padding:5px 8px;background:var(--bg);border:1px solid var(--b2);border-radius:4px;color:var(--t1);font-size:9px;font-family:var(--mono);outline:none;margin-bottom:5px}
.sb-setup-inp:focus{border-color:var(--acc)}
.sb-setup-inp::placeholder{color:var(--t3)}
.sb-setup-btn{width:100%;padding:6px;background:var(--acc);border:none;border-radius:4px;color:#fff;font-size:10px;font-weight:600;cursor:pointer;font-family:var(--font);transition:background .15s}
.sb-setup-btn:hover{background:var(--acc2)}

/* Main */
.main{margin-left:220px;flex:1;padding:24px 28px;min-width:0}
.ph{margin-bottom:18px}
.ph-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.ph-title{font-size:20px;font-weight:700;flex:1}

/* Period rows */
.period-wrap{display:flex;flex-direction:column;gap:6px}
.period-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:7px 12px;border-radius:7px;background:var(--bg1);border:1px solid var(--b1)}
.period-row.p2{border-color:rgba(167,139,250,.25);background:rgba(167,139,250,.04)}
.plabel{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:3px 7px;border-radius:4px;margin-right:4px;white-space:nowrap}
.plabel.l1{background:rgba(79,142,247,.15);color:var(--acc)}
.plabel.l2{background:rgba(167,139,250,.15);color:var(--pur)}
.prange{font-size:10px;color:var(--t3);font-family:var(--mono);margin-left:6px;white-space:nowrap}
.pbtn{padding:5px 10px;border-radius:5px;font-size:11px;cursor:pointer;border:1px solid var(--b2);background:transparent;color:var(--t2);font-family:var(--font);transition:all .15s;white-space:nowrap}
.pbtn:hover{border-color:var(--acc);color:var(--acc)}
.pbtn.act{background:rgba(79,142,247,.15);border-color:var(--acc);color:var(--acc)}
.pbtn.act2{background:rgba(167,139,250,.15);border-color:var(--pur);color:var(--pur)}
.pbtn.cmp-toggle{font-size:11px}
.pbtn.cmp-toggle.on{background:rgba(167,139,250,.15);border-color:var(--pur);color:var(--pur)}
.dsep{color:var(--t3);font-size:11px}
.dinp{background:var(--bg);border:1px solid var(--b2);border-radius:5px;padding:5px 9px;color:var(--t1);font-size:11px;font-family:var(--mono);outline:none;width:116px}
.dinp:focus{border-color:var(--acc)}
.dinp.p2{border-color:rgba(167,139,250,.35)}
.dinp.p2:focus{border-color:var(--pur)}

/* Demo banner */
.demo-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;background:rgba(234,179,8,.06);border:1px solid rgba(234,179,8,.22);border-radius:7px;font-size:11.5px;color:var(--t2);line-height:1.5;margin-bottom:16px}
.demo-banner strong{color:var(--yel)}
.demo-icon{color:var(--yel);font-size:15px;flex-shrink:0;line-height:1.4}
.mock-badge{display:inline-block;margin-left:6px;padding:1px 5px;background:rgba(234,179,8,.15);border:1px solid rgba(234,179,8,.3);border-radius:3px;font-size:8px;color:var(--yel);text-transform:uppercase;letter-spacing:.06em;vertical-align:middle;font-weight:600}

/* KPI */
.kgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:10px;margin-bottom:18px}
.kcard{background:var(--bg1);border:1px solid var(--b1);border-radius:8px;padding:13px 15px}
.klbl{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-bottom:5px}
.kval{font-size:19px;font-weight:700;font-family:var(--mono);line-height:1}
.kcomp{display:flex;align-items:center;gap:6px;margin-top:7px;padding-top:7px;border-top:1px solid var(--b1)}
.kval2{font-size:13px;font-weight:500;font-family:var(--mono);color:var(--pur)}
.kdelta{font-size:10px;font-weight:600;font-family:var(--mono);padding:2px 5px;border-radius:3px}
.kdelta.pos{color:var(--grn);background:rgba(34,200,117,.1)}
.kdelta.neg{color:var(--red);background:rgba(244,80,80,.1)}
.c-ora{color:var(--ora)}.c-grn{color:var(--grn)}.c-acc{color:var(--acc)}.c-yel{color:var(--yel)}.c-wht{color:var(--t1)}

/* Charts */
.cgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}
@media(max-width:900px){.cgrid{grid-template-columns:1fr}}
.ccard{background:var(--bg1);border:1px solid var(--b1);border-radius:8px;padding:16px}
.ctitle{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--t3);margin-bottom:10px}
.clegend{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.cleg-item{display:flex;align-items:center;gap:5px;font-size:9.5px;color:var(--t2)}
.cleg-solid{width:16px;height:2px;border-radius:1px;flex-shrink:0}
.cleg-dashed{width:16px;height:0;flex-shrink:0}

/* Table */
.tcard{background:var(--bg1);border:1px solid var(--b1);border-radius:8px;overflow:hidden;margin-bottom:20px}
.thead2{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--b1);gap:12px}
.ttitle{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--t3)}
.thint{font-size:10px;color:var(--t3)}
.tscroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;white-space:nowrap}
th{padding:7px 11px;text-align:right;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--t3);border-bottom:1px solid var(--b1);background:var(--bg);position:sticky;top:0;cursor:default}
th:first-child{text-align:left;min-width:160px}
th.sortable{cursor:pointer;user-select:none;transition:color .12s}
th.sortable:hover{color:var(--t2)}
th.sact{color:var(--acc)!important}
.sicon{margin-left:3px;font-size:8px;opacity:.6}
td{padding:8px 11px;text-align:right;border-bottom:1px solid rgba(30,42,62,.5);font-family:var(--mono);color:var(--t2);font-size:11px}
td:first-child{text-align:left;font-family:var(--font);color:var(--t1);font-weight:500;font-size:12px}
tr:hover td{background:rgba(22,29,46,.7)}
.tr-total td{border-top:1px solid var(--b2);color:var(--t1);font-weight:700;background:rgba(10,14,22,.6)}
.cf-spend{color:var(--ora)!important}.cf-funnel{color:var(--acc)!important}.cf-money{color:var(--grn)!important}
.ht-grn{color:#22C875!important;font-weight:600}
.ht-yel{color:#EAB308!important;font-weight:600}
.ht-red{color:#F45050!important;font-weight:600}

/* Login */
.lw{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);position:relative;overflow:hidden}
.lw::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 45% at 50% 0%,rgba(79,142,247,.07) 0%,transparent 70%)}
.lcard{position:relative;width:370px;background:var(--bg1);border:1px solid var(--b2);border-radius:12px;padding:36px}
.ltitle{font-size:22px;font-weight:700;margin-bottom:4px}
.lsub{font-size:12px;color:var(--t2);margin-bottom:26px;line-height:1.5}
.fgrp{margin-bottom:14px}
.flbl{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--t2);margin-bottom:5px}
.finp{width:100%;padding:9px 13px;background:var(--bg);border:1px solid var(--b2);border-radius:6px;color:var(--t1);font-size:13px;font-family:var(--font);outline:none;transition:border-color .15s}
.finp:focus{border-color:var(--acc)}
.ferr{background:rgba(244,80,80,.08);border:1px solid rgba(244,80,80,.25);border-radius:5px;padding:7px 11px;font-size:11px;color:var(--red);margin-bottom:13px}
.fsubmit{width:100%;padding:10px;background:var(--acc);border:none;border-radius:6px;color:#fff;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;transition:background .15s;margin-top:4px}
.fsubmit:hover{background:var(--acc2)}
.lhint{margin-top:18px;padding:11px;background:rgba(79,142,247,.05);border:1px solid rgba(79,142,247,.1);border-radius:6px;font-size:10.5px;color:var(--t2);font-family:var(--mono);line-height:2}
.lhint-t{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-bottom:5px;font-family:var(--font)}
.sbadge{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}
`;

// ─── TABLE COLUMNS ────────────────────────────────────────────────────────────

const COLS = [
  { k:"spend",       lbl:"Расход (каб.)",  f:rubFull, cls:"cf-spend"  },
  { k:"salary",      lbl:"ЗП",             f:rubFull, cls:"cf-spend"  },
  { k:"totalSpend",  lbl:"Расход+ЗП",      f:rubFull, cls:"cf-spend"  },
  { k:"cpm",         lbl:"CPM",            f:rubFull, cls:""          },
  { k:"impressions", lbl:"Показы",         f:ru,      cls:""          },
  { k:"clicks",      lbl:"Клики",          f:ru,      cls:""          },
  { k:"ctr",         lbl:"CTR",            f:pct2,    cls:""          },
  { k:"leads",       lbl:"Лиды",           f:ru,      cls:"cf-funnel" },
  { k:"cpl",         lbl:"CPL",            f:rubFull, cls:""          },
  { k:"c1ql",        lbl:"C1QL",           f:pct,     cls:"cf-funnel" },
  { k:"qual",        lbl:"Квал.",          f:ru,      cls:"cf-funnel" },
  { k:"cpql",        lbl:"CPQL",           f:rubFull, cls:""          },
  { k:"demo",        lbl:"Демо",           f:ru,      cls:"cf-funnel" },
  { k:"crQualDemo",  lbl:"CR квал→демо",   f:pct,     cls:"cf-funnel" },
  { k:"sales",       lbl:"Продажи",        f:ru,      cls:"cf-money"  },
  { k:"crDemoSale",  lbl:"CR демо→прод.",  f:pct,     cls:"cf-funnel" },
  { k:"crQlSale",    lbl:"CR QL→прод.",    f:pct,     cls:"cf-funnel" },
  { k:"cac",         lbl:"CAC",            f:rubFull, cls:""          },
  { k:"revenue",     lbl:"Сумма продаж",   f:rubFull, cls:"cf-money"  },
  { k:"avgPrice",    lbl:"Avg. price",     f:rubFull, cls:""          },
  { k:"cogsPct",     lbl:"% COGS",         f:pct,     cls:""          },
  { k:"cogs",        lbl:"COGS",           f:rubFull, cls:""          },
  { k:"grossMargin", lbl:"Gross margin",   f:rubFull, cls:"cf-money"  },
];

// ─── LOGIN ────────────────────────────────────────────────────────────────────

function Login({ onLogin }) {
  const [login, setLogin] = useState("");
  const [pwd, setPwd]     = useState("");
  const [err, setErr]     = useState("");
  const submit = () => {
    const u = USERS[login];
    if (!u || u.pwd !== pwd) { setErr("Неверный логин или пароль"); return; }
    onLogin({ id: login, ...u });
  };
  return (
    <div className="lw">
      <div className="lcard">
        <div className="ltitle">AdMetrics</div>
        <div className="lsub">Сквозная аналитика рекламных источников</div>
        {err && <div className="ferr">{err}</div>}
        <div className="fgrp">
          <label className="flbl">Логин</label>
          <input className="finp" value={login}
            onChange={e=>{setLogin(e.target.value);setErr("")}}
            placeholder="admin" onKeyDown={e=>e.key==="Enter"&&submit()}/>
        </div>
        <div className="fgrp">
          <label className="flbl">Пароль</label>
          <input className="finp" type="password" value={pwd}
            onChange={e=>{setPwd(e.target.value);setErr("")}}
            placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&submit()}/>
        </div>
        <button className="fsubmit" onClick={submit}>Войти</button>
        <div className="lhint">
          <div className="lhint-t">Тестовые аккаунты</div>
          admin / admin123 — все вкладки<br/>
          yandex_partner / yandex123<br/>
          rsya_partner / rsya123<br/>
          vk_partner / vk123 · tg_partner / tg123<br/>
          hh_partner / hh123 · avito_partner / avito123<br/>
          mts_partner / mts123
        </div>
      </div>
    </div>
  );
}

// ─── KPI GRID ────────────────────────────────────────────────────────────────

function KPIGrid({ data, data2, cmp, isMock }) {
  const cards = [
    { lbl:"Расход (кабинет)", k:"spend",       val:rubK(data.spend||0),              cls:"c-ora" },
    { lbl:"Расход + ЗП",      k:"totalSpend",  val:rubK(data.totalSpend||0),         cls:"c-ora" },
    { lbl:"Лиды",             k:"leads",       val:ru(data.leads||0),                 cls:"c-acc" },
    { lbl:"CPL",              k:"cpl",         val:rubFull(data.cpl||0),              cls:"c-wht" },
    { lbl:"Квалиф. лиды",    k:"qual",        val:ru(data.qual||0),                  cls:"c-acc" },
    { lbl:"C1QL",             k:"c1ql",        val:pct(data.c1ql||0),                 cls:"c-acc" },
    { lbl:"CPQL",             k:"cpql",        val:rubFull(data.cpql||0),             cls:"c-wht" },
    { lbl:"Демо",             k:"demo",        val:ru(data.demo||0),                  cls:"c-acc" },
    { lbl:"CR квал→демо",    k:"crQualDemo",  val:pct(data.crQualDemo||0),           cls:"c-acc" },
    { lbl:"Продажи",          k:"sales",       val:ru(data.sales||0),                 cls:"c-grn" },
    { lbl:"CR демо→прод.",   k:"crDemoSale",  val:pct(data.crDemoSale||0),           cls:"c-grn" },
    { lbl:"Выручка",          k:"revenue",     val:rubK(data.revenue||0),             cls:"c-grn" },
    { lbl:"CAC",              k:"cac",         val:rubFull(data.cac||0),              cls:"c-yel" },
    { lbl:"COGS",             k:"cogs",        val:rubK(data.cogs||0),                cls:"c-wht" },
    { lbl:"Gross Margin",     k:"grossMargin", val:rubK(data.grossMargin||0),         cls:"c-grn" },
  ];

  return (
    <div className="kgrid">
      {cards.map(c => {
        const v2 = cmp && data2 ? (data2[c.k] || 0) : null;
        const col = COLS.find(x=>x.k===c.k);
        const val2str = v2 !== null ? (col ? col.f(v2) : rubK(v2)) : null;
        let delta = null;
        if (v2 !== null && v2 !== 0) {
          const d = ((( data[c.k]||0) - v2) / Math.abs(v2)) * 100;
          delta = { d, pos: d >= 0 };
        }
        return (
          <div key={c.lbl} className="kcard">
            <div className="klbl">{c.lbl}{isMock && c.k==="spend" ? <span className="mock-badge">демо</span> : ""}</div>
            <div className={`kval ${c.cls}`}>{c.val}</div>
            {cmp && val2str && (
              <div className="kcomp">
                <span className="kval2">{val2str}</span>
                {delta && (
                  <span className={`kdelta ${delta.pos?"pos":"neg"}`}>
                    {delta.pos?"↑":"↓"}{Math.abs(delta.d).toFixed(1)}%
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── TOOLTIP ─────────────────────────────────────────────────────────────────

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{background:"#0F1520",border:"1px solid #1E2A3E",borderRadius:6,
      padding:"8px 11px",fontSize:10.5,fontFamily:"'JetBrains Mono',monospace"}}>
      <div style={{color:"#8A95A8",marginBottom:4}}>{label}</div>
      {payload.map(p=>{
        let disp = p.value;
        if (p.name.includes("CTR")) disp = pct2(p.value);
        else if (p.value > 500) disp = rubFull(p.value);
        return <div key={p.dataKey} style={{color:p.color,marginBottom:1}}>{p.name}: {disp}</div>;
      })}
    </div>
  );
};

// ─── CHARTS ──────────────────────────────────────────────────────────────────

function groupByDay(rows) {
  const map = {};
  rows.forEach(r => {
    if (!map[r.date]) map[r.date] = {date:r.date,spend:0,leads:0,demo:0,impressions:0,clicks:0};
    map[r.date].spend       += r.spend;
    map[r.date].leads       += r.leads;
    map[r.date].demo        += r.demo;
    map[r.date].impressions += r.impressions;
    map[r.date].clicks      += r.clicks;
  });
  return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date)).map(r=>({
    ...r, ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
  }));
}

function Charts({ rows1, rows2, cmp }) {
  const p1 = useMemo(()=>groupByDay(rows1),       [rows1]);
  const p2 = useMemo(()=>cmp?groupByDay(rows2):[], [rows2,cmp]);

  const mkData = (keys) => {
    const len = Math.max(p1.length, cmp ? p2.length : 0);
    return Array.from({length: len}, (_, i) => {
      const obj = { day: `День ${i+1}` };
      keys.forEach(k => {
        obj[`${k}1`] = p1[i]?.[k] ?? null;
        if (cmp) obj[`${k}2`] = p2[i]?.[k] ?? null;
      });
      return obj;
    });
  };

  const c1data = useMemo(()=>mkData(["spend","leads","ctr"]), [p1,p2,cmp]);
  const c2data = useMemo(()=>mkData(["leads","demo"]),        [p1,p2,cmp]);

  const tick = {fontSize:8,fill:"#4A5568",fontFamily:"JetBrains Mono"};
  const grid = {strokeDasharray:"3 3",stroke:"#1E2A3E"};

  const LegItem = ({color, label, dashed}) => (
    <span className="cleg-item">
      {dashed
        ? <span className="cleg-dashed" style={{borderTop:`2px dashed ${color}`,opacity:.6}}/>
        : <span className="cleg-solid"  style={{background:color}}/>}
      {label}
    </span>
  );

  return (
    <div className="cgrid">

      {/* Chart 1: Расход + Лиды + CTR */}
      <div className="ccard">
        <div className="ctitle">Динамика расходов, лидов и CTR по дням</div>
        <div className="clegend">
          <LegItem color="#F97316" label="Расход П1"/>
          <LegItem color="#4F8EF7" label="Лиды П1"/>
          <LegItem color="#22C875" label="CTR П1"/>
          {cmp && <LegItem color="#8A95A8" label="П2" dashed/>}
        </div>
        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={c1data} margin={{top:2,right:8,bottom:0,left:-16}}>
            <CartesianGrid {...grid}/>
            <XAxis dataKey="day" tick={tick} interval="preserveStartEnd"/>
            <YAxis yAxisId="s" tick={tick}/>
            <YAxis yAxisId="l" orientation="right" tick={tick}/>
            <YAxis yAxisId="c" orientation="right" hide/>
            <Tooltip content={<Tip/>}/>
            <Line yAxisId="s" type="monotone" dataKey="spend1"  name="Расход П1 ₽" stroke="#F97316" strokeWidth={1.5} dot={false} connectNulls/>
            <Line yAxisId="l" type="monotone" dataKey="leads1"  name="Лиды П1"     stroke="#4F8EF7" strokeWidth={1.5} dot={false} connectNulls/>
            <Line yAxisId="c" type="monotone" dataKey="ctr1"    name="CTR П1"      stroke="#22C875" strokeWidth={1.5} dot={false} connectNulls/>
            {cmp && <Line yAxisId="s" type="monotone" dataKey="spend2" name="Расход П2 ₽" stroke="#F97316" strokeWidth={1.2} strokeDasharray="5 3" dot={false} connectNulls opacity={0.5}/>}
            {cmp && <Line yAxisId="l" type="monotone" dataKey="leads2" name="Лиды П2"     stroke="#4F8EF7" strokeWidth={1.2} strokeDasharray="5 3" dot={false} connectNulls opacity={0.5}/>}
            {cmp && <Line yAxisId="c" type="monotone" dataKey="ctr2"   name="CTR П2"      stroke="#22C875" strokeWidth={1.2} strokeDasharray="5 3" dot={false} connectNulls opacity={0.5}/>}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Chart 2: Лиды + Демо */}
      <div className="ccard">
        <div className="ctitle">Динамика лидов и демо по дням</div>
        <div className="clegend">
          <LegItem color="#4F8EF7" label="Лиды П1"/>
          <LegItem color="#A78BFA" label="Демо П1"/>
          {cmp && <LegItem color="#8A95A8" label="П2" dashed/>}
        </div>
        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={c2data} margin={{top:2,right:8,bottom:0,left:-16}}>
            <CartesianGrid {...grid}/>
            <XAxis dataKey="day" tick={tick} interval="preserveStartEnd"/>
            <YAxis tick={tick}/>
            <Tooltip content={<Tip/>}/>
            <Line type="monotone" dataKey="leads1" name="Лиды П1" stroke="#4F8EF7" strokeWidth={1.5} dot={false} connectNulls/>
            <Line type="monotone" dataKey="demo1"  name="Демо П1" stroke="#A78BFA" strokeWidth={1.5} dot={false} connectNulls/>
            {cmp && <Line type="monotone" dataKey="leads2" name="Лиды П2" stroke="#4F8EF7" strokeWidth={1.2} strokeDasharray="5 3" dot={false} connectNulls opacity={0.5}/>}
            {cmp && <Line type="monotone" dataKey="demo2"  name="Демо П2" stroke="#A78BFA" strokeWidth={1.2} strokeDasharray="5 3" dot={false} connectNulls opacity={0.5}/>}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── DATA TABLE ───────────────────────────────────────────────────────────────

// Подсветка значений в сводной таблице
function heatmapClass(colKey, value) {
  if (!value && value !== 0) return "";
  switch (colKey) {
    case "cpql":
      if (value < 18000)  return "ht-grn";
      if (value <= 22000) return "ht-yel";
      return "ht-red";
    case "crQualDemo":
      if (value > 0.50)  return "ht-grn";
      if (value >= 0.30) return "ht-yel";
      return "ht-red";
    case "crDemoSale":
      if (value > 0.15)  return "ht-grn";
      if (value >= 0.08) return "ht-yel";
      return "ht-red";
    case "grossMargin":
      if (value > 0)  return "ht-grn";
      if (value < 0)  return "ht-red";
      return "";
    default: return "";
  }
}


function buildCampRow(name, a, w) {
  const spend = Math.round((a.spend||0)*w), salary = Math.round((a.salary||0)*w);
  const totalSpend = spend + salary;
  const imp    = Math.round((a.impressions||0)*w);
  const clicks = Math.round((a.clicks||0)*w);
  const leads  = Math.round((a.leads||0)*w), qual = Math.round((a.qual||0)*w);
  const demo   = Math.round((a.demo||0)*w),  sales = Math.round((a.sales||0)*w);
  const revenue = Math.round((a.revenue||0)*w);
  const cogsPct = COGS_RATE;
  const cogs    = Math.round(revenue * cogsPct);
  const grossMargin = revenue - cogs - totalSpend;
  return {
    name, color:null, spend, salary, totalSpend, impressions:imp, clicks,
    leads, qual, demo, sales, revenue, cogs, grossMargin,
    ctr:        imp>0   ? clicks/imp                    : 0,
    cpm:        imp>0   ? Math.round((totalSpend/imp)*1000) : 0,
    cpl:        leads>0 ? Math.round(totalSpend/leads)  : 0,
    c1ql:       leads>0 ? qual/leads                    : 0,
    cpql:       qual>0  ? Math.round(totalSpend/qual)   : 0,
    crQualDemo: qual>0  ? demo/qual                     : 0,
    crDemoSale: demo>0  ? sales/demo                    : 0,
    crQlSale:   qual>0  ? sales/qual                    : 0,
    cac:        sales>0 ? Math.round(totalSpend/sales)  : 0,
    avgPrice:   sales>0 ? Math.round(revenue/sales)     : 0,
    cogsPct,
  };
}

function DataTable({ rows, isSummary, srcId }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("desc");

  const handleSort = (k) => {
    if (!isSummary) return;
    if (sortKey === k) setSortDir(d => d==="desc"?"asc":"desc");
    else { setSortKey(k); setSortDir("desc"); }
  };

  const tableRows = useMemo(()=>{
    if (isSummary) {
      let base = SOURCES.map(s => {
        const a = agg(rows.filter(r=>r.source===s.id));
        return { name:s.label, color:s.color, ...a };
      });
      if (sortKey) base = [...base].sort((a,b)=>
        sortDir==="desc" ? (b[sortKey]||0)-(a[sortKey]||0) : (a[sortKey]||0)-(b[sortKey]||0)
      );
      return base;
    }
    const camps = CAMPAIGNS[srcId]||[], ws = CAMP_W[srcId]||camps.map(()=>1/camps.length);
    const a = agg(rows);
    return camps.map((c,i)=>buildCampRow(c,a,ws[i]));
  },[rows,isSummary,srcId,sortKey,sortDir]);

  const total = useMemo(()=>agg(rows),[rows]);

  return (
    <div className="tcard">
      <div className="thead2">
        <div className="ttitle">{isSummary?"Сводная таблица по источникам":"Разбивка по кампаниям"}</div>
        {isSummary && <div className="thint">↕ Кликните заголовок столбца для сортировки</div>}
      </div>
      <div className="tscroll">
        <table>
          <thead>
            <tr>
              <th>{isSummary?"Источник":"Кампания"}</th>
              {COLS.map(c=>{
                const isAct = sortKey===c.k;
                return (
                  <th key={c.k}
                    className={`${isSummary?"sortable":""} ${isAct?"sact":""}`}
                    onClick={()=>handleSort(c.k)}>
                    {c.lbl}
                    {isSummary && <span className="sicon">{isAct?(sortDir==="desc"?"▼":"▲"):"⇅"}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {tableRows.map(row=>(
              <tr key={row.name}>
                <td>
                  {row.color && <span className="sbadge" style={{background:row.color}}/>}
                  {row.name}
                </td>
                {COLS.map(col=>{
                  const ht = isSummary ? heatmapClass(col.k, row[col.k]??0) : "";
                  return (
                    <td key={col.k} className={ht || col.cls}>
                      {col.f(row[col.k]??0)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="tr-total">
              <td>ИТОГО</td>
              {COLS.map(col=>{
                const ht = isSummary ? heatmapClass(col.k, total[col.k]??0) : "";
                return (
                  <td key={col.k} className={ht || col.cls}>
                    {col.f(total[col.k]??0)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── DATE ROW ────────────────────────────────────────────────────────────────

function DateRow({ isP2, preset, setPreset, cfrom, setCfrom, cto, setCto, range, cmp }) {
  const label = cmp ? (isP2 ? "П2" : "П1") : null;
  return (
    <div className={`period-row${isP2?" p2":""}`}>
      {label && <span className={`plabel ${isP2?"l2":"l1"}`}>{label}</span>}
      {PRESETS.map(p=>(
        <button key={p.id}
          className={`pbtn ${!cfrom&&preset===p.id ? (isP2?"act2":"act") : ""}`}
          onClick={()=>{ setPreset(p.id); setCfrom(""); setCto(""); }}>
          {p.label}
        </button>
      ))}
      <span className="dsep">|</span>
      <input type="date" className={`dinp${isP2?" p2":""}`} value={cfrom}
        onChange={e=>{ setCfrom(e.target.value); }}/>
      <span className="dsep">—</span>
      <input type="date" className={`dinp${isP2?" p2":""}`} value={cto}
        onChange={e=>{ setCto(e.target.value); }}/>
      {cmp && range && (
        <span className="prange">{fmtRange(range)}</span>
      )}
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [user, setUser]   = useState(null);
  const [tab, setTab]     = useState("summary");

  const [preset1, setP1]  = useState("year");
  const [cf1, setCf1]     = useState("");
  const [ct1, setCt1]     = useState("");

  const [cmp, setCmp]     = useState(false);
  const [preset2, setP2]  = useState("prev");
  const [cf2, setCf2]     = useState("");
  const [ct2, setCt2]     = useState("");

  // ── Данные рекламных кабинетов ────────────────────────────────────────────
  const [adLookup,       setAdLookup]       = useState(null);
  const [adError,        setAdError]         = useState(null);
  const [adUpdated,      setAdUpdated]       = useState(null);
  const [adRowCount,     setAdRowCount]      = useState(0);
  const [salesLookup,    setSalesLookup]     = useState(null);
  const [salesError,     setSalesError]      = useState(null);
  const [salesUpdated,   setSalesUpdated]    = useState(null);
  const [debugChannels,  setDebugChannels]   = useState(null);
  const [showDebug,      setShowDebug]       = useState(false);

  const tsNow = () => new Date().toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});

  // Один запрос к Apps Script — получаем и рекламные данные, и продажи
  const doLoad = () => {
    setAdLookup(null);    setAdError(null);
    setSalesLookup(null); setSalesError(null);
    loadAllData()
      .then(({ adLookup: al, salesLookup: sl, debugChannels: dc }) => {
        setAdLookup(al);
        setAdRowCount(Object.keys(al).length);
        setAdUpdated(tsNow());
        setSalesLookup(sl);
        setSalesUpdated(tsNow());
        setDebugChannels(dc);
      })
      .catch(e => {
        setAdError(e.message);
        setSalesError(e.message);
      });
  };

  // Оставляем doLoadAd / doLoadSales как алиасы для кнопок ↻ в сайдбаре
  const doLoadAd    = doLoad;
  const doLoadSales = doLoad;

  useEffect(() => { doLoad(); }, []);

  const range1 = useMemo(()=> cf1&&ct1 ? {from:cf1,to:ct1} : presetRange(preset1), [preset1,cf1,ct1]);
  const range2 = useMemo(()=> cf2&&ct2 ? {from:cf2,to:ct2} : presetRange(preset2), [preset2,cf2,ct2]);

  // Построить строки для заданного диапазона с реальными или mock данными
  const buildRows = (range) => {
    const sources = tab === "summary" ? SOURCES.map(s=>s.id) : [tab];

    const mockRows = () => sources.flatMap(srcId =>
      filterRows(RAW[srcId], range.from, range.to).map(r => ({...r, source: srcId, _mock: true}))
    );

    if (!adLookup) return mockRows();

    // Собираем все даты из обоих источников (рекламные + продажи)
    const dateSet = new Set();
    let d = new Date(range.from);
    const end = new Date(range.to);
    while (d <= end) {
      dateSet.add(d.toISOString().split("T")[0]);
      d.setDate(d.getDate() + 1);
    }

    const rows = [];
    for (const ds of dateSet) {
      for (const srcId of sources) {
        const ad = adLookup[`${ds}__${srcId}`];
        const sd = salesLookup ? salesLookup[`${ds}__${srcId}`] : null;

        // Берём строку если есть рекламные данные ИЛИ данные продаж
        if (!ad && !sd) continue;

        const row = {
          date: ds, source: srcId,
          spend:       ad?.spend       || 0,
          salary:      ad?.salary      || 0,
          totalSpend:  ad?.totalSpend  || 0,
          impressions: ad?.impressions || 0,
          clicks:      ad?.clicks      || 0,
          leads:       ad?.leads       || 0,
          qual:        sd?.qual        || 0,
          demo:        sd?.demo        || 0,
          sales:       sd?.sales       || 0,
          revenue:     sd?.revenue     || 0,
          cogs:        sd ? Math.round((sd.revenue||0) * COGS_RATE) : 0,
          grossMargin: 0,
        };
        row.grossMargin = row.revenue - row.cogs - row.totalSpend;
        rows.push(row);
      }
    }

    if (rows.length === 0) return mockRows();
    return rows;
  };

  const rows1 = useMemo(()=>buildRows(range1), [tab,range1,adLookup,salesLookup]);
  const rows2 = useMemo(()=>cmp?buildRows(range2):[], [tab,range2,cmp,adLookup,salesLookup]);
  const agg1  = useMemo(()=>agg(rows1), [rows1]);
  const agg2  = useMemo(()=>cmp?agg(rows2):null, [rows2,cmp]);

  // После rows1 — иначе ReferenceError (temporal dead zone)
  const isMockData = useMemo(() => {
    if (!adLookup) return true;
    return rows1.length > 0 && rows1[0]?._mock === true;
  }, [adLookup, rows1]);

  if (!user) return (
    <><style>{CSS}</style><Login onLogin={u=>{ setUser(u); setTab(u.tabs[0]); }}/></>
  );

  const isSummary   = tab==="summary";
  const src         = SOURCES.find(s=>s.id===tab);
  const pageTitle   = isSummary ? "Сводная аналитика" : (src?.label||"");
  const allowedTabs = user.tabs;

  return (
    <><style>{CSS}</style>
    <div className="app">

      {/* Sidebar */}
      <aside className="sb">
        <div className="sb-logo">
          <div className="sb-title">AdMetrics</div>
          <div className="sb-sub">Рекламная аналитика</div>
        </div>
        <nav className="sb-nav">
          {allowedTabs.includes("summary") && (
            <>
              <div className="sb-section">Обзор</div>
              <div className={`sb-item${tab==="summary"?" act":""}`} onClick={()=>setTab("summary")}>
                <span style={{fontSize:13}}>◈</span> Сводная
              </div>
            </>
          )}
          <div className="sb-section">Источники трафика</div>
          {SOURCES.filter(s=>allowedTabs.includes(s.id)).map(s=>(
            <div key={s.id} className={`sb-item${tab===s.id?" act":""}`} onClick={()=>setTab(s.id)}>
              <span className="dot" style={{background:s.color}}/>
              {s.label}
            </div>
          ))}
        </nav>
        <div className="sb-user">
          <div className="sb-uname">{user.name}</div>
          <div className="sb-urole">
            {user.tabs.length===1
              ? `Доступ: ${SOURCES.find(s=>s.id===user.tabs[0])?.short}`
              : "Полный доступ"}
          </div>
          {/* Data status */}
          <div className="sb-sync">
            <div className="sync-row">
              <span className="sync-lbl">Кабинеты</span>
              {adLookup===null && !adError && <span className="sync-loading">⟳ загрузка…</span>}
              {adLookup && <span className="sync-ok">✓ {adUpdated} · {adRowCount} стр <button className="sync-btn" onClick={doLoadAd}>↻</button></span>}
              {adError && <span className="sync-err">✕ <button className="sync-btn" onClick={doLoadAd}>↻</button></span>}
            </div>
            {adError && <div className="sync-errmsg">{adError}</div>}
            <div className="sync-row">
              <span className="sync-lbl">Продажи</span>
              {salesLookup===null && !salesError && <span className="sync-loading">⟳ загрузка…</span>}
              {salesLookup && <span className="sync-ok">✓ {salesUpdated} <button className="sync-btn" onClick={doLoadSales}>↻</button></span>}
              {salesError && <span className="sync-err">✕ нет доступа <button className="sync-btn" onClick={doLoadSales}>↻</button></span>}
            </div>
            {salesLookup && debugChannels && Object.keys(debugChannels).length > 0 && (
              <div style={{marginTop:4}}>
                <button className="sync-btn" style={{width:"100%",textAlign:"left",padding:"2px 5px"}}
                  onClick={()=>setShowDebug(v=>!v)}>
                  {showDebug?"▲ скрыть":"▼ Z-значения оплат ("}{Object.values(debugChannels).reduce((a,b)=>a+b,0)}{showDebug?")":")"}
                </button>
                {showDebug && (
                  <div className="debug-channels">
                    {Object.entries(debugChannels).sort((a,b)=>b[1]-a[1]).map(([ch,cnt])=>{
                      const mapped = mapChannel(ch);
                      return (
                        <div key={ch} className={`debug-row ${mapped?"":"unmapped"}`}>
                          <span className="debug-cnt">{cnt}×</span>
                          <span className="debug-src">{mapped||"—"}</span>
                          <span className="debug-val" title={ch}>{ch.length>18?ch.slice(0,17)+"…":ch}</span>
                        </div>
                      );
                    })}
                    {/* Показываем даты rsya-записей в salesLookup */}
                    {salesLookup && (() => {
                      const rsyaDates = Object.keys(salesLookup)
                        .filter(k=>k.endsWith("__rsya"))
                        .map(k=>k.split("__")[0])
                        .sort();
                      if (!rsyaDates.length) return null;
                      return (
                        <div style={{marginTop:4,paddingTop:4,borderTop:"1px solid var(--b1)"}}>
                          <div style={{color:"var(--ora)",fontSize:8,marginBottom:2}}>РСЯ продажи (даты лидов):</div>
                          {rsyaDates.map(d=>(
                            <div key={d} style={{fontSize:8,color:"var(--t3)",fontFamily:"var(--mono)"}}>{d}</div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
            {(adError || salesError) && (
              <div className="sync-hint">Откройте таблицу → Настройки доступа → «Все, у кому есть ссылка» → Читатель</div>
            )}
          </div>
          <button className="sb-logout" onClick={()=>setUser(null)}>Выйти</button>
        </div>
      </aside>

      {/* Content */}
      <main className="main">
        <div className="ph">
          <div className="ph-row">
            <div className="ph-title">{pageTitle}</div>
            <button
              className={`pbtn cmp-toggle${cmp?" on":""}`}
              onClick={()=>setCmp(v=>!v)}>
              {cmp ? "✕ Убрать сравнение" : "⇄ Сравнить периоды"}
            </button>
          </div>
          <div className="period-wrap">
            <DateRow isP2={false} preset={preset1} setPreset={setP1}
              cfrom={cf1} setCfrom={setCf1} cto={ct1} setCto={setCt1}
              range={range1} cmp={cmp}/>
            {cmp && (
              <DateRow isP2={true} preset={preset2} setPreset={setP2}
                cfrom={cf2} setCfrom={setCf2} cto={ct2} setCto={setCt2}
                range={range2} cmp={cmp}/>
            )}
          </div>
          {isMockData && (
            <div className="demo-banner">
              <span className="demo-icon">⚠</span>
              <span>
                Показаны <strong>демо-данные</strong>
                {adLookup !== null && adRowCount === 0 && " — таблица кабинетов загружена, но за выбранный период данных нет (все строки пустые)"}
                {adLookup === null && " — идёт загрузка из Google Sheets…"}
                {adLookup !== null && adRowCount > 0 && ` — загружено ${adRowCount} строк, но за выбранный период данных нет`}
              </span>
            </div>
          )}
        </div>

        <KPIGrid data={agg1} data2={agg2} cmp={cmp} isMock={isMockData}/>
        <Charts rows1={rows1} rows2={rows2} cmp={cmp}/>
        <DataTable rows={rows1} isSummary={isSummary} srcId={tab}/>
      </main>
    </div>
    </>
  );
}
