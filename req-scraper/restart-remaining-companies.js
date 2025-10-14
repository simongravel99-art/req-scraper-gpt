import { pool } from "./db/pool.js";
import fs from 'fs';
import csv from 'csv-parser';

async function restartRemainingCompanies() {
  console.log("🔄 Restarting processing for remaining companies...");

  try {
    // Get list of processed companies from CSV
    const processedCompanies = new Set();
    const csvContent = fs.readFileSync('./req_extracted_data.csv', 'utf8');
    const lines = csvContent.split('\n').filter(line => line.trim());

    for (let i = 1; i < lines.length; i++) { // Skip header
      const columns = lines[i].split(',');
      if (columns[0]) {
        // Clean company name from CSV
        let companyName = columns[0].replace(/^"?|"?$/g, '').trim();
        // Remove version text
        companyName = companyName.replace(/Version du nom dans une autre langue:.*$/i, '').trim();
        processedCompanies.add(companyName.toUpperCase());
      }
    }

    console.log(`✅ Found ${processedCompanies.size} already processed companies`);

    // Get full list of companies from Sherbrooke CSV
    const allCompanies = [];
    return new Promise((resolve, reject) => {
      fs.createReadStream('./sherbrooke_inc.csv', { encoding: 'utf8' })
        .pipe(csv({
          skipEmptyLines: true,
          skipLinesWithError: true
        }))
        .on('data', (row) => {
          const companyName = row.proprietaire_nom || row['﻿proprietaire_nom'];
          if (companyName && companyName.trim()) {
            allCompanies.push(companyName.trim());
          }
        })
        .on('end', async () => {
          console.log(`📊 Total companies in Sherbrooke list: ${allCompanies.length}`);

          // Find remaining companies
          const remainingCompanies = allCompanies.filter(company => {
            return !processedCompanies.has(company.toUpperCase());
          });

          console.log(`⏳ Remaining companies to process: ${remainingCompanies.length}`);

          if (remainingCompanies.length === 0) {
            console.log("🎉 All companies have been processed!");
            await pool.end();
            return resolve();
          }

          // Skip clearing jobs - just add new ones
          console.log("➡️ Adding fresh jobs for remaining companies...");

          // Queue remaining companies
          let queued = 0;
          for (const company of remainingCompanies) { // Queue ALL remaining
            try {
              // Insert page record
              await pool.query(
                `INSERT INTO pages (project, url, data, created_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), NOW())
                 ON CONFLICT (project, url) DO UPDATE SET
                 data = $3, updated_at = NOW()`,
                [
                  'req-scraper-remaining',
                  `company-${company.replace(/[^a-zA-Z0-9]/g, '-')}`,
                  JSON.stringify({
                    company_name: company,
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
                    project: 'req-scraper-remaining',
                    url: `company-${company.replace(/[^a-zA-Z0-9]/g, '-')}`,
                    companyName: company
                  })
                ]
              );

              queued++;
            } catch (error) {
              console.error(`❌ Error queuing ${company}:`, error.message);
            }
          }

          console.log(`✅ Queued ${queued} remaining companies for processing`);
          console.log("🚀 Start worker with: node main-worker.js");

          await pool.end();
          resolve();
        })
        .on('error', reject);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
  }
}

restartRemainingCompanies().catch(console.error);