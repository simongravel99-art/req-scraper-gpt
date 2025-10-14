import { pool } from "./db/pool.js";
import fs from 'fs';
import csv from 'csv-parser';

async function processSherbrookeCompanies() {
  const companies = [];

  console.log("📊 Reading sherbrooke_inc.csv...");

  // Read CSV file
  return new Promise((resolve, reject) => {
    fs.createReadStream('./sherbrooke_inc.csv', { encoding: 'utf8' })
      .pipe(csv({
        skipEmptyLines: true,
        skipLinesWithError: true
      }))
      .on('data', (row) => {
        // Handle both possible column names due to BOM issues
        const companyName = row.proprietaire_nom || row['﻿proprietaire_nom'];
        const companyAddress = row.proprietaire_adresse;

        if (companyName && companyName.trim()) {
          companies.push({
            name: companyName.trim(),
            address: companyAddress ? companyAddress.trim() : ''
          });
        }
      })
      .on('end', async () => {
        console.log(`✓ Found ${companies.length} companies to process`);

        try {
          let queued = 0;
          let skipped = 0;

          for (const company of companies) {
            try {
              // Insert page record
              await pool.query(
                `INSERT INTO pages (project, url, data, created_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), NOW())
                 ON CONFLICT (project, url) DO UPDATE SET
                 data = $3, updated_at = NOW()`,
                [
                  'req-scraper-sherbrooke',
                  `company-${company.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
                  JSON.stringify({
                    company_name: company.name,
                    company_address: company.address,
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
                    project: 'req-scraper-sherbrooke',
                    url: `company-${company.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
                    companyName: company.name
                  })
                ]
              );

              queued++;

              if (queued % 50 === 0) {
                console.log(`✓ Queued ${queued} companies...`);
              }

            } catch (error) {
              console.error(`Error queuing ${company.name}:`, error.message);
              skipped++;
            }
          }

          console.log(`\n🎉 Processing complete!`);
          console.log(`✓ Queued: ${queued} companies`);
          console.log(`⚠️ Skipped: ${skipped} companies`);
          console.log(`\n🚀 Start the worker with: node main-worker.js`);
          console.log(`📊 Monitor progress with database queries`);

          await pool.end();
          resolve();

        } catch (error) {
          console.error('Error processing companies:', error);
          await pool.end();
          reject(error);
        }
      })
      .on('error', (error) => {
        console.error('Error reading CSV:', error);
        reject(error);
      });
  });
}

processSherbrookeCompanies().catch(console.error);