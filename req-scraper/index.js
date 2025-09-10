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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function launchBrowser() {
  const proxy = process.env.PROXY_SERVER ? {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME || undefined,
    password: process.env.PROXY_PASSWORD || undefined,
  } : undefined;
  return chromium.launch({ headless: !HEADFUL, proxy });
}

async function clickAcceder(page) {
  await page.waitForLoadState('domcontentloaded');
  const acc1 = page.getByRole('link', { name: /accéder au service/i });
  const acc2 = page.locator('a:has-text("Accéder au service")');
  if (await acc1.count()) { await acc1.first().click(); return; }
  if (await acc2.count()) { await acc2.first().click(); return; }
}

async function searchCompany(page, company) {
  await page.waitForLoadState('domcontentloaded');

  // Accept terms
  const tos = page.getByLabel(/je reconnais.*conditions.*(service|en ligne)/i);
  if (await tos.count()) {
    try { await tos.check({ force: true }); } catch {}
  } else {
    const cb = page.locator('input[type="checkbox"]');
    if (await cb.count()) { try { await cb.first().check({ force: true }); } catch {} }
  }

  // Search input
  let box = page.getByRole('textbox', { name: /nom.*entreprise|nom/i }).first();
  if (!await box.count()) box = page.locator('form:has-text("Rechercher une entreprise") input[type="text"]').first();
  if (!await box.count()) box = page.locator('input[type="text"]').first();

  await box.fill('');
  await box.type(company, { delay: 20 });

  // Click Rechercher
  const searchBtn = page.getByRole('button', { name: /rechercher/i }).first();
  if (await searchBtn.count()) {
    await searchBtn.click();
  } else {
    await page.locator('button:has-text("Rechercher")').first().click();
  }
  await page.waitForLoadState('networkidle');
}

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
  // exact label → next element
  for (const label of labels) {
    const xpath = `//*[normalize-space(text())='${label}']/following-sibling::*[1]`;
    const el = page.locator(`xpath=${xpath}`).first();
    if (await el.count()) {
      const val = (await el.innerText()).trim();
      if (val) return val;
    }
  }
  // fuzzy: contains(label) → next sibling
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickAcceder(page);
    await page.waitForLoadState('domcontentloaded');
    await searchCompany(page, company);
    const opened = await openResult(page, company);
    if (!opened) throw new Error('No result row to open');
    const data = await scrapeDetails(page);
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
  // Allow either CSV or plain newline list
  const lines = rows.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0].includes(',')) {
    // CSV mode
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
