import { pool } from "./db/pool.js";
import { readFileSync } from "fs";

async function seedJobs() {
  const companies = readFileSync('./entreprises.csv', 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.trim());

  console.log(`Seeding ${companies.length} REQ scraping jobs...`);

  for (const companyName of companies) {
    try {
      // Insert page record
      await pool.query(
        `INSERT INTO pages (project, url, data, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (project, url) DO NOTHING`,
        [
          'req-scraper',
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
          'reqStealthRotate',
          json_build_object(
            'project', $1,
            'url', $2,
            'companyName', $3
          ),
          max_attempts => 3,
          priority => 1
        )`,
        [
          'req-scraper',
          `company-${companyName.replace(/[^a-zA-Z0-9]/g, '-')}`,
          companyName
        ]
      );

      console.log(`✓ Queued: ${companyName}`);
    } catch (error) {
      console.error(`Error queuing ${companyName}:`, error.message);
    }
  }

  console.log(`\n🚀 Successfully queued ${companies.length} REQ scraping jobs!`);
  console.log("Start the worker with: node main-worker.js");
}

seedJobs().catch(console.error).finally(() => process.exit(0));