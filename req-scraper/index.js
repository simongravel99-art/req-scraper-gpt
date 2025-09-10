import { chromium } from 'playwright';
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
