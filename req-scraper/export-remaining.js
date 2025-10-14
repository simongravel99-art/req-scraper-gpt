import fs from 'fs';
import csv from 'csv-parser';

const processed = new Set();

// Read processed companies from CSV
fs.createReadStream('req_extracted_data.csv')
  .pipe(csv())
  .on('data', (row) => {
    const name = row['Company_Name'] || row['﻿Company_Name'];
    if (name && name.trim()) {
      const cleanName = name.split('Version du nom')[0].trim().toUpperCase();
      processed.add(cleanName);
    }
  })
  .on('end', () => {
    console.log(`Processed companies: ${processed.size}`);

    const remaining = [];

    // Read all companies from Sherbrooke list
    fs.createReadStream('sherbrooke_inc.csv')
      .pipe(csv())
      .on('data', (row) => {
        const name = row['proprietaire_nom'] || row['﻿proprietaire_nom'];
        if (name && name.trim()) {
          const cleanName = name.trim().toUpperCase();
          if (!processed.has(cleanName)) {
            remaining.push(name.trim());
          }
        }
      })
      .on('end', () => {
        console.log(`Remaining companies: ${remaining.length}`);
        console.log(`\nFirst 10:`);
        remaining.slice(0, 10).forEach((name, i) => {
          console.log(`  ${i + 1}. ${name}`);
        });

        fs.writeFileSync('remaining_to_scrape.json', JSON.stringify(remaining, null, 2));
        console.log(`\nSaved to remaining_to_scrape.json`);
      });
  });
