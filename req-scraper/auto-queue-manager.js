import { pool } from "./db/pool.js";
import fs from 'fs';
import csv from 'csv-parser';

let isRunning = false;

async function autoQueueManager() {
  if (isRunning) {
    console.log("Queue manager already running, skipping...");
    return;
  }

  isRunning = true;
  console.log("🔄 Auto Queue Manager started");

  try {
    while (true) {
      // Check pending jobs
      const pendingResult = await pool.query(
        'SELECT COUNT(*) as count FROM graphile_worker.jobs WHERE run_at <= NOW() AND locked_at IS NULL;'
      );
      const pendingJobs = parseInt(pendingResult.rows[0].count);

      console.log(`📊 Current pending jobs: ${pendingJobs}`);

      // If less than 10 jobs pending, add more
      if (pendingJobs < 10) {
        console.log("🎯 Low job count detected, adding more companies...");

        // Get processed companies from CSV
        const processedCompanies = new Set();
        try {
          const csvContent = fs.readFileSync('./req_extracted_data.csv', 'utf8');
          const lines = csvContent.split('\n').filter(line => line.trim());

          for (let i = 1; i < lines.length; i++) { // Skip header
            const columns = lines[i].split(',');
            if (columns[0]) {
              let companyName = columns[0].replace(/^"?|"?$/g, '').trim();
              companyName = companyName.replace(/Version du nom dans une autre langue:.*$/i, '').trim();
              processedCompanies.add(companyName.toUpperCase());
            }
          }
        } catch (error) {
          console.log("⚠️ Could not read CSV, continuing...");
        }

        // Get remaining companies
        const allCompanies = [];
        await new Promise((resolve, reject) => {
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
            .on('end', resolve)
            .on('error', reject);
        });

        const remainingCompanies = allCompanies.filter(company => {
          return !processedCompanies.has(company.toUpperCase());
        });

        console.log(`📈 Progress: ${processedCompanies.size}/${allCompanies.length} companies processed`);
        console.log(`⏳ Remaining: ${remainingCompanies.length} companies`);

        if (remainingCompanies.length === 0) {
          console.log("🎉 ALL COMPANIES PROCESSED! Queue manager stopping.");
          break;
        }

        // Add next batch of companies (25 at a time)
        const batchSize = Math.min(25, remainingCompanies.length);
        let queued = 0;

        for (const company of remainingCompanies.slice(0, batchSize)) {
          try {
            // Insert page record
            await pool.query(
              `INSERT INTO pages (project, url, data, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())
               ON CONFLICT (project, url) DO UPDATE SET
               data = $3, updated_at = NOW()`,
              [
                'req-scraper-auto',
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
                  project: 'req-scraper-auto',
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

        console.log(`✅ Added ${queued} more companies to queue`);
      }

      // Wait 2 minutes before checking again
      console.log("⏱️ Waiting 2 minutes before next check...");
      await new Promise(resolve => setTimeout(resolve, 120000));

    }
  } catch (error) {
    console.error('❌ Queue manager error:', error.message);
  } finally {
    isRunning = false;
    await pool.end();
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down queue manager...');
  process.exit(0);
});

autoQueueManager().catch(console.error);