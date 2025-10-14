import { pool } from "./db/pool.js";

async function test5Companies() {
  const companies = [
    "INVESTISSEMENTS OLYMBEC INC.",
    "SOCIETE IMMOBILIERE PRIVEE CARON & TREPANIER INC.",
    "EQUATIO MARKETING ET EXPORTATION INC.",
    "LOUAGE GUYVON INC.",
    "DELUXE IMMOBILIER INC."
  ];

  console.log(`Testing REQ scraper with ${companies.length} companies:`);
  companies.forEach((name, i) => console.log(`${i+1}. ${name}`));

  for (const companyName of companies) {
    try {
      // Insert page record
      await pool.query(
        `INSERT INTO pages (project, url, data, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (project, url) DO UPDATE SET
         data = $3, updated_at = NOW()`,
        [
          'req-scraper-test',
          `company-${companyName.replace(/[^a-zA-Z0-9]/g, '-')}`,
          JSON.stringify({
            company_name: companyName,
            status: 'pending',
            created_at: new Date().toISOString()
          })
        ]
      );

      // Queue job
      await pool.query(
        `SELECT graphile_worker.add_job(
          $1,
          $2,
          max_attempts => 3,
          priority => 1
        )`,
        [
          'downloadPage/reqStealthRotateSimple',
          JSON.stringify({
            project: 'req-scraper-test',
            url: `company-${companyName.replace(/[^a-zA-Z0-9]/g, '-')}`,
            companyName: companyName
          })
        ]
      );

      console.log(`✓ Queued: ${companyName}`);
    } catch (error) {
      console.error(`Failed to queue ${companyName}:`, error.message);
    }
  }

  console.log("\n🚀 Start the worker with: node main-worker.js");
  console.log("📊 Monitor progress and check CSV output");

  await pool.end();
}

test5Companies().catch(console.error);