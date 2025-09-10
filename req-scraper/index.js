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

  // Probe page + all frames
  const contexts = [page, ...page.frames()];

  // Find the real REGQ search form: it has a Rechercher button
  let form = null, formCtx = null;

  outerForm:
  for (const ctx of contexts) {
    const candidates = ctx.locator('form');
    const n = await candidates.count();
    for (let i = 0; i < Math.min(n, 10); i++) {
      const f = candidates.nth(i);
      const hasBtn = await f.getByRole('button', { name: /rechercher/i }).count()
        || await f.locator('button:has-text("Rechercher")').count()
        || await f.locator('input[type="submit"][value*="Rechercher" i]').count();
      if (hasBtn) { form = f; formCtx = ctx; break outerForm; }
    }
  }
  if (!form) {
    await debugDump(page, 'search form not found');
    throw new Error('Search form not found');
  }

  // Accept TOS inside the form if present
  try {
    const tos = form.locator('input[type="checkbox"]');
    if (await tos.count()) { await tos.first().check({ force: true, timeout: 1000 }).catch(() => {}); }
  } catch {}

  // Find the company-name input INSIDE the form
  const inputSelectors = [
    'input[placeholder*="nom" i]',
    'input[aria-label*="nom" i]',
    'input[name*="nom" i]',
    'input[id*="nom" i]',
    'input[type="search"]',
    'input[type="text"]',
  ];
  let box = null;
  for (const sel of inputSelectors) {
    const cand = form.locator(sel).first();
    if (await cand.count()) {
      try { if (await cand.isVisible()) { box = cand; break; } } catch {}
    }
  }
  if (!box) {
    await debugDump(page, 'search box not found (form-scoped)');
    throw new Error('Search box not found (form)');
  }

  await box.fill('');
  await box.type(company, { delay: 20 });

  // Click the Rechercher INSIDE the form
  let searchBtn =
      form.getByRole('button', { name: /rechercher/i }).first();
  if (!await searchBtn.count())
      searchBtn = form.locator('button:has-text("Rechercher")').first();
  if (!await searchBtn.count())
      searchBtn = form.locator('input[type="submit"][value*="Rechercher" i]').first();
  if (!await searchBtn.count()) {
    await debugDump(page, 'rechercher button not found (form-scoped)');
    throw new Error('Rechercher button not found');
  }

  await searchBtn.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  // small settle
  await page.waitForTimeout(800);
}


async function openResult(page, company) {
  const contexts = [page, ...page.frames()];
  const nameRe = new RegExp(escRe(company), 'i');

  // Wait briefly for results or a "no result" message anywhere
  const waited = await Promise.race(
    contexts.map(ctx => ctx.locator('a:has-text("Consulter"), button:has-text("Consulter")').first().waitFor({ timeout: 4000 }).then(() => 'hasConsulter').catch(() => null))
  ).catch(() => null);

  // If no quick signal, still proceed to search manually
  for (const ctx of contexts) {
    // If there's an explicit "no result" message, bail early
    const noRes = await ctx.locator(':text-matches("aucun résultat|aucune entreprise", "i")').first().count();
    if (noRes) return false;

    // Prefer a row that contains the company name, then click its Consulter
    const rows = ctx.locator('section, article, li, tr, div').filter({ hasText: nameRe });
    const rc = await rows.count();
    for (let i = 0; i < Math.min(rc, 20); i++) {
      const row = rows.nth(i);
      const consulter = row.locator('a:has-text("Consulter"), button:has-text("Consulter")').first();
      if (await consulter.count()) { await consulter.click(); return true; }
    }

    // Fallback: first Consulter anywhere
    const any = ctx.locator('a:has-text("Consulter"), button:has-text("Consulter")').first();
    if (await any.count()) { await any.click(); return true; }
  }

  await debugDump(page, 'no Consulter found');
  return false;
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




