import { pool } from "./db/pool.js";

async function testSingleCompany() {
  const companyName = "PLACEMENTS DVV INC.";

  console.log(`Testing REQ multi-worker scraper with: ${companyName}`);

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
        'downloadPage/reqStealthRotate',
        JSON.stringify({
          project: 'req-scraper-test',
          url: `company-${companyName.replace(/[^a-zA-Z0-9]/g, '-')}`,
          companyName: companyName
        })
      ]
    );

    console.log(`✓ Queued test job: ${companyName}`);
    console.log("\n🚀 Start the worker with: node main-worker.js");
    console.log("📊 Monitor progress with database queries or logs");

  } catch (error) {
    console.error(`Error queuing test job:`, error.message);
  }
}

testSingleCompany().catch(console.error).finally(() => process.exit(0));