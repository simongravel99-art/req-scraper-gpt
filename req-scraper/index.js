#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs-extra';
import { CSVProcessor } from './lib/csv-processor.js';
import { RequestLayer } from './lib/request-layer.js';
import { DebugLogger } from './lib/debug-logger.js';
import { REQScraper } from './lib/req-scraper.js';
import { stringify } from 'csv-stringify/sync';

// Load environment variables
dotenv.config();

class REQScraperCLI {
  constructor() {
    this.program = new Command();
    this.setupCommands();
  }

  setupCommands() {
    this.program
      .name('req-scraper')
      .description('REQ (Registre des entreprises du Québec) company scraper')
      .version('1.0.0');

    // Main run command
    this.program
      .command('run')
      .description('Run the REQ scraper on a CSV of companies')
      .requiredOption('--companies-csv <file>', 'Path to CSV file containing company names')
      .option('--name-column <column>', 'Column name or index for company names (default: 0)', '0')
      .option('--limit <number>', 'Limit processing to first N companies', parseInt)
      .option('--debug', 'Enable debug logging and failure artifacts')
      .option('--trace', 'Enable request/response header tracing')
      .option('--proxy-pool <file>', 'Path to proxy pool file')
      .option('--output-dir <dir>', 'Output directory', 'output')
      .action(this.runCommand.bind(this));

    // Probe command for selector testing
    this.program
      .command('probe')
      .description('Probe a single page for selector testing')
      .requiredOption('--url <url>', 'URL to probe')
      .option('--debug', 'Enable debug logging')
      .action(this.probeCommand.bind(this));
  }

  async runCommand(options) {
    try {
      // Validate required environment variables
      this.validateEnvironment();

      // Initialize components
      const logger = new DebugLogger({
        debug: options.debug,
        trace: options.trace,
        quiet: false
      });

      const csvProcessor = new CSVProcessor({
        nameColumn: isNaN(options.nameColumn) ? options.nameColumn : parseInt(options.nameColumn),
        logger
      });

      const requestLayer = new RequestLayer({
        timeout: parseInt(process.env.REQUEST_TIMEOUT_MS) || 60000,
        maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
        requestsPerMinute: parseInt(process.env.REQUESTS_PER_MINUTE) || 5,
        maxConcurrency: parseInt(process.env.MAX_CONCURRENCY) || 1,
        minDelay: parseInt(process.env.MIN_DELAY_BETWEEN_REQUESTS_MS) || 15000,
        maxDelay: parseInt(process.env.MAX_DELAY_BETWEEN_REQUESTS_MS) || 25000,
        proxyPoolFile: options.proxyPool || process.env.PROXY_POOL_FILE,
        debug: options.debug,
        logger
      });

      // Ensure output directory exists
      await fs.ensureDir(options.outputDir);

      logger.info(`Starting REQ scraper with options:`, {
        companiesCsv: options.companiesCsv,
        nameColumn: options.nameColumn,
        limit: options.limit,
        debug: options.debug,
        outputDir: options.outputDir
      });

      // Read companies from CSV
      const companies = await csvProcessor.readCompanies(options.companiesCsv, options.limit);

      if (companies.length === 0) {
        logger.error('No companies found in CSV file');
        process.exit(1);
      }

      // Initialize request layer
      await requestLayer.initialize();

      // Initialize scraper with stealth settings
      const scraper = new REQScraper({
        requestLayer,
        logger,
        debug: options.debug,
        pageLoadDelay: parseInt(process.env.PAGE_LOAD_DELAY_MS) || 8000,
        formInteractionDelay: parseInt(process.env.FORM_INTERACTION_DELAY_MS) || 3000
      });

      await scraper.initialize();

      // Process companies
      const results = [];
      const ambiguousMatches = [];

      for (const company of companies) {
        try {
          logger.info(`Processing company: ${company.name}`);

          const result = await scraper.searchAndScrapeCompany(company.name);

          if (result.status === 'success') {
            results.push(result.data);
            logger.incrementOutputRows();
          } else if (result.status === 'ambiguous') {
            ambiguousMatches.push({
              companyName: company.name,
              searchQuery: result.searchQuery,
              matches: result.matches
            });
            logger.logAmbiguousMatch(company.name, result.searchQuery, result.matches);
          } else {
            logger.warn(`Failed to process ${company.name}: ${result.reason}`);
          }

        } catch (error) {
          logger.error(`Error processing ${company.name}: ${error.message}`, { error });
        }
      }

      // Write outputs
      await this.writeOutputs(results, ambiguousMatches, options.outputDir, logger);

      // Clean up
      await scraper.close();

      // Show final metrics
      const metrics = await logger.getMetricsSummary();
      console.log('\n=== SCRAPING SUMMARY ===');
      console.log(`Duration: ${metrics.duration_human}`);
      console.log(`Pages: ${metrics.pages.attempted} attempted, ${metrics.pages.succeeded} succeeded (${metrics.pages.success_rate})`);
      console.log(`Blocks: ${metrics.block_rate} rate (403: ${metrics.blocks['403']}, 429: ${metrics.blocks['429']}, 5xx: ${metrics.blocks['5xx']})`);
      console.log(`Retries: ${metrics.retries}`);
      console.log(`Average latency: ${metrics.avg_latency_ms}ms`);
      console.log(`Output rows: ${metrics.output_rows}`);
      console.log(`Ambiguous matches: ${metrics.ambiguous_matches}`);

    } catch (error) {
      console.error(`Scraper failed: ${error.message}`);
      process.exit(1);
    }
  }

  async probeCommand(options) {
    const logger = new DebugLogger({ debug: options.debug });

    try {
      logger.info(`Probing URL: ${options.url}`);
      // TODO: Implement probe functionality
      logger.warn('Probe command not yet implemented');
    } catch (error) {
      logger.error(`Probe failed: ${error.message}`);
      process.exit(1);
    }
  }

  validateEnvironment() {
    const required = ['REQ_BASE_URL'];
    const missing = required.filter(env => !process.env[env]);

    if (missing.length > 0) {
      console.error(`Missing required environment variables: ${missing.join(', ')}`);
      console.error('Please copy .env.example to .env and configure your settings');
      process.exit(1);
    }
  }

  async writeOutputs(results, ambiguousMatches, outputDir, logger) {
    // Write JSONL output
    const jsonlPath = path.join(outputDir, 'req_results.jsonl');
    const jsonlContent = results.map(r => JSON.stringify(r)).join('\n');
    await fs.writeFile(jsonlPath, jsonlContent);
    logger.info(`Wrote ${results.length} results to ${jsonlPath}`);

    // Write CSV output
    if (results.length > 0) {
      const csvPath = path.join(outputDir, 'req_results.csv');
      const csvContent = stringify(results, { header: true });
      await fs.writeFile(csvPath, csvContent);
      logger.info(`Wrote ${results.length} results to ${csvPath}`);
    }

    // Write ambiguous matches
    if (ambiguousMatches.length > 0) {
      const ambiguousPath = path.join(outputDir, 'ambiguous.csv');
      const csvProcessor = new CSVProcessor({ logger });
      await csvProcessor.writeAmbiguous(ambiguousMatches, ambiguousPath);
    }
  }

  run() {
    this.program.parse();
  }
}

// Entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = new REQScraperCLI();
  cli.run();
}