import { chromium } from 'playwright';
import fs from 'fs';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import dotenv from 'dotenv';

dotenv.config();

const BASE = 'https://www.registreentreprises.gouv.qc.ca/';
const OUTFILE = process.env.OUTPUT || 'out.csv';
const DELAY = Number(process.env.REQUEST_DELAY_MS || 2000);
const HEADFUL = process.env.HEADFUL === '1';
const DEBUG = process.env.DEBUG === '1';


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }


async function debugDump(page, tag = '') {
  if (!DEBUG) return;
  try {
    console.log(`[DBG] ${tag} page url: ${page.url()}`);
    for (const p of page.context().pages()) {
      console.log('[DBG] ctx page:', p.url());
    }
    for (const f of page.frames()) {
      console.log('[DBG] frame:', f.url());
    }
  } catch (e) {
    console.log('[DBG] debugDump error:', e?.message || e);
  }
}




async function launchBrowser() {
  const proxy = process.env.PROXY_SERVER ? {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME || undefined,
    password: process.env.PROXY_PASSWORD || undefined,
  } : undefined;
  return chromium.launch({ headless: !HEADFUL, proxy });
}

// Click "Accéder au service" and return the page that actually hosts the search
async function clickAcceder(page) {
  await page.waitForLoadState('domcontentloaded');

  const candidates = [
    page.getByRole('link', { name: /accéder au service/i }),
    page.getByRole('button', { name: /accéder au service/i }),
    page.locator('a:has-text("Accéder au service"), button:has-text("Accéder au service")'),
  ];

  for (const loc of candidates) {
    if (await loc.count()) {
      const [popup, newPage] = await Promise.all([
        page.waitForEvent('popup').catch(() => null),          // target=_blank flow
        page.context().waitForEvent('page').catch(() => null), // sometimes opens a new page (same tab stays idle)
        loc.first().click()
      ]);
      const svc = popup || newPage || page;

      // some flows land on an intermediate message; allow a short settle
      await svc.waitForLoadState('domcontentloaded').catch(() => {});
      await svc.waitForTimeout(800);
      return svc;
    }
  }
  return page;
}

async function searchCompany(page, company) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200); // let iframes attach
  await debugDump(page, 'before search');
  
  // Build a list of contexts to probe: the page + all frames
  const contexts = [page, ...page.frames()];

  // Dismiss cookie / modal if shown anywhere
  for (const ctx of contexts) {
    const cookieBtn = ctx.getByRole('button', { name: /j.?accepte|accepter|ok|d'accord|continue/i });
    if (await cookieBtn.count()) { try { await cookieBtn.first().click({ timeout: 800 }); } catch {} }
  }

  // Accept TOS if present (checkbox is required before "Rechercher" enables)
  for (const ctx of contexts) {
    let tos = ctx.getByLabel(/je reconnais.*conditions.*(service|en ligne)/i);
    if (!await tos.count()) tos = ctx.locator('input[type="checkbox"]');
    if (await tos.count()) { try { await tos.first().check({ force: true, timeout: 800 }); break; } catch {} }
  }

  // Find a visible search input (very permissive selectors)
  let box = null;
  outer:
  for (const ctx of contexts) {
    const candidates = [
      'input[placeholder*="nom" i]',
      'input[aria-label*="nom" i]',
      'input[name*="nom" i]',
      'input[id*="nom" i]',
      'input[type="search"]',
      'input[type="text"]'
    ];
    for (const sel of candidates) {
      const cand = ctx.locator(sel).first();
      if (await cand.count()) {
        try {
          if (await cand.isVisible()) { box = cand; break outer; }
        } catch {}
      }
    }
  }
  // ...loops that try to find `box` in page + frames...

  // ⬇️ INSERT BLOCK A HERE
  if (!box) {
    await debugDump(page, 'search box not found');
    throw new Error('Search box not found (page or iframes)');
  }

  await box.fill('');
  await box.type(company, { delay: 20 });


  // Click Rechercher (button or submit input)
  let searchBtn = null;
  outerBtn:
  for (const ctx of contexts) {
    const btns = [
      'button:has-text("Rechercher")',
      'input[type="submit"][value*="Rechercher" i]',
    ];
    for (const sel of btns) {
      const cand = ctx.locator(sel).first();
      if (await cand.count()) { searchBtn = cand; break outerBtn; }
    }
    const byRole = ctx.getByRole('button', { name: /rechercher/i }).first();
    if (await byRole.count()) { searchBtn = byRole; break; }
  }
  // ...loops that try to find `searchBtn` in page + frames...

  // ⬇️ INSERT BLOCK B HERE
  if (!searchBtn) {
    await debugDump(page, 'rechercher button not found');
    throw new Error('Rechercher button not found');
  }

  await searchBtn.click();
  await page.waitForLoadState('networkidle').catch(() => {});



async function openResult(page, company) {
  const nameRe = new RegExp(escRe(company), 'i');
  const rows = page.locator('section, article, li, div').filter({ hasText: nameRe });
  const count = await rows.count();
  if (count) {
    for (let i = 0; i < Math.min(count, 10); i++) {
      const row = rows.nth(i);
      const consulter = row.getByRole('link', { name: /consulter/i }).first();
      if (await consulter.count()) { await consulter.click(); return true; }
      const consulterBtn = row.locator('a:has-text("Consulter"), button:has-text("Consulter")').first();
      if (await consulterBtn.count()) { await consulterBtn.click(); return true; }
    }
  }
  const anyConsulter = page.getByRole('link', { name: /consulter/i }).first();
  if (await anyConsulter.count()) { await anyConsulter.click(); return true; }
  return false;
}

async function getFieldByLabel(page, labels) {
  for (const label of labels) {
    const xpath = `//*[normalize-space(text())='${label}']/following-sibling::*[1]`;
    const el = page.locator(`xpath=${xpath}`).first();
    if (await el.count()) {
      const val = (await el.innerText()).trim();
      if (val) return val;
    }
  }
  for (const label of labels) {
    const el = page.locator(`xpath=//*[contains(normalize-space(.), '${label}')]`).first();
    if (await el.count()) {
      const sib = el.locator('xpath=following-sibling::*[1]');
      if (await sib.count()) return (await sib.innerText()).trim();
    }
  }
  return '';
}

async function scrapeDetails(page) {
  await page.waitForLoadState('domcontentloaded');
  const data = {};
  data.page_title = (await page.title()) || '';
  data.neq = await getFieldByLabel(page, ["Numéro d'entreprise (NEQ)", "NEQ", "No d'entreprise (NEQ)"]);
  data.nom = await getFieldByLabel(page, ['Nom', 'Dénomination sociale']);
  data.adresse_siege = await getFieldByLabel(page, ['Adresse du siège', 'Adresse du domicile élu', 'Adresse du domicile', 'Adresse du siège social']);
  data.date_constitution = await getFieldByLabel(page, ['Date de constitution', 'Date de création']);
  data.forme_juridique = await getFieldByLabel(page, ['Forme juridique', 'Type de personne']);
  data.statut = await getFieldByLabel(page, ['Statut au registre', 'Statut']);

  const dirigeantsSection = page.locator('xpath=//*[contains(translate(text(), "DIRIGEANTSADMINISTRATEURS", "dirigeantsadministrateurs"), "dirigeants") or contains(translate(text(), "DIRIGEANTSADMINISTRATEURS", "dirigeantsadministrateurs"), "administrateurs")]/ancestor::*[self::section or self::div][1]');
  if (await dirigeantsSection.count()) {
    const items = dirigeantsSection.locator('li, tr, div');
    const n = Math.min(await items.count(), 25);
    const dirigeants = [];
    for (let i = 0; i < n; i++) {
      const t = (await items.nth(i).innerText()).trim().replace(/\s+/g, ' ');
      if (t && t.length > 5) dirigeants.push(t);
    }
    data.dirigeants_raw = dirigeants.join(' | ');
  } else {
    const allText = (await page.locator('main').innerText()).trim();
    const match = allText.match(/Dirigeants?[\s\S]{0,800}/i);
    data.dirigeants_raw = match ? match[0].replace(/\s+/g, ' ') : '';
  }
  return data;
}

async function processOne(browser, company) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8' },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await debugDump(page, 'after goto BASE');
    const svc = await clickAcceder(page);
    await svc.waitForLoadState('domcontentloaded');
    await debugDump(svc, 'after clickAcceder');
    await searchCompany(svc, company);
    const opened = await openResult(svc, company);
    if (!opened) throw new Error('No result row to open');
    const data = await scrapeDetails(svc);
    data.input_company = company;
    return { ok: true, data };
  } catch (e) {
    console.error(`[ERR] ${company}:`, e.message);
    return { ok: false, data: { input_company: company, error: String(e.message || e) } };
  } finally {
    await ctx.close();
    await sleep(DELAY);
  }
}


async function readCompanies(file) {
  if (!file) throw new Error('Provide companies.csv path');
  const rows = await fs.promises.readFile(file, 'utf8');
  const lines = rows.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0].includes(',')) {
    return new Promise((resolve, reject) => {
      const names = [];
      parse(rows, {}, (err, out) => {
        if (err) return reject(err);
        for (const r of out) if (r[0]) names.push(String(r[0]).trim());
        resolve(names);
      });
    });
  }
  return lines;
}

async function writeCsv(records) {
  return new Promise((resolve, reject) => {
    stringify(records, { header: true }, (err, csv) => {
      if (err) return reject(err);
      fs.writeFileSync(OUTFILE, csv);
      resolve();
    });
  });
}

(async () => {
  try {
    const inputPath = process.argv[2] || 'companies.csv';
    const companies = await readCompanies(inputPath);
    console.log(`Loaded ${companies.length} companies`);

    const browser = await launchBrowser();
    const out = [];

    for (const name of companies) {
      console.log(`→ ${name}`);
      const res = await processOne(browser, name);
      out.push(res.data);
    }
    await browser.close();

    await writeCsv(out);
    console.log(`Saved ${out.length} rows to ${OUTFILE}`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();


