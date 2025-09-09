#!/usr/bin/env node

import { program } from 'commander';
import dotenv from 'dotenv';
import pino from 'pino';
import fs from 'fs-extra';
import path from 'path';
import xlsx from 'xlsx';
import { parse as csvParse } from 'csv-parse/sync';
import { stringify as csvStringify } from 'csv-stringify/sync';
import pLimit from 'p-limit';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { CompanyNormalizer } from './lib/normalizer.js';
import { REQScraper } from './lib/req-scraper.js';
import { CorpCanScraper } from './lib/corpcan-scraper.js';
import { MatchingEngine } from './lib/matching-engine.js';
import { CacheManager } from './lib/cache-manager.js';
import { AuditLogger } from './lib/audit-logger.js';
import { OwnershipExporter } from './lib/ownership-exporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      },
      {
        target: 'pino/file',
        options: { 
          destination: path.join(__dirname, 'audit/logs/app.log'),
          mkdir: true
        }
      }
    ]
  }
});

class EnterpriseEnrichmentTool {
  constructor(options) {
    this.options = options;
    this.normalizer = new CompanyNormalizer();
    this.matchingEngine = new MatchingEngine(options.strict);
    this.cacheManager = new CacheManager(path.join(__dirname, '.cache'));
    this.auditLogger = new AuditLogger(path.join(__dirname, 'audit'));
    
    const rateLimitMs = (1000 / options.rateLimit) || 1000;
    this.reqScraper = new REQScraper({
      proxy: options.proxy,
      rateLimit: rateLimitMs,
      timeout: options.timeout || 30000,
      snapshot: options.snapshot,
      extractOwnership: options.extractOwnership !== false,
      logger
    });
    
    this.corpCanScraper = new CorpCanScraper({
      proxy: options.proxy,
      rateLimit: rateLimitMs,
      timeout: options.timeout || 30000,
      logger
    });
    
    this.limit = pLimit(options.concurrency || 2);
    
    this.ownershipExporter = new OwnershipExporter({
      outputDir: path.dirname(options.output),
      format: options.ownershipFormat || 'both',
      logger
    });
    
    this.enrichedResults = [];
    this.unmatchedResults = [];
    
    this.stats = {
      total: 0,
      matched: 0,
      unmatched: 0,
      errors: 0,
      startTime: Date.now()
    };
  }

  async loadInputFile() {
    const { input, sheet, columnName, hintCityCol } = this.options;
    
    logger.info(`Loading input file: ${input}`);
    
    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`);
    }
    
    const ext = path.extname(input).toLowerCase();
    let data = [];
    
    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.readFile(input);
      const sheetName = sheet || workbook.SheetNames[0];
      
      if (!workbook.Sheets[sheetName]) {
        throw new Error(`Sheet "${sheetName}" not found in workbook`);
      }
      
      data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    } else if (ext === '.csv') {
      const content = fs.readFileSync(input, 'utf-8');
      data = csvParse(content, { columns: true });
    } else {
      throw new Error('Unsupported file format. Use .xlsx, .xls or .csv');
    }
    
    if (data.length === 0) {
      throw new Error('No data found in input file');
    }
    
    if (!data[0].hasOwnProperty(columnName)) {
      throw new Error(`Column "${columnName}" not found. Available columns: ${Object.keys(data[0]).join(', ')}`);
    }
    
    const companies = data.map(row => ({
      name: row[columnName],
      hintCity: hintCityCol ? row[hintCityCol] : null,
      originalRow: row
    })).filter(c => c.name && c.name.trim());
    
    logger.info(`Loaded ${companies.length} companies from ${input}`);
    return companies;
  }

  async processCompany(company) {
    const normalizedName = this.normalizer.normalize(company.name);
    
    logger.info(`Processing: ${company.name}`);
    
    try {
      const cacheKey = `${normalizedName}_${company.hintCity || ''}`;
      const cached = await this.cacheManager.get('enriched', cacheKey);
      
      if (cached && !this.options.noCache) {
        logger.debug(`Cache hit for: ${company.name}`);
        return { ...cached, company_name_input: company.name };
      }
      
      let result = await this.searchREQ(company, normalizedName);
      
      if (!result || result.match_score < 0.88) {
        const corpCanResult = await this.searchCorpCan(company, normalizedName);
        if (corpCanResult && (!result || corpCanResult.match_score > result.match_score)) {
          result = corpCanResult;
        }
      }
      
      if (!result || result.match_score < 0.88) {
        result = this.checkPublicBody(company, normalizedName) || result;
      }
      
      if (result && result.match_score >= 0.88) {
        const shareholderNames = [];
        const administratorNames = [];
        const beneficiaryNames = [];
        
        if (result.shareholders && Array.isArray(result.shareholders)) {
          result.shareholders.forEach(s => {
            if (s.name) shareholderNames.push(s.name);
          });
        }
        
        if (result.administrators && Array.isArray(result.administrators)) {
          result.administrators.forEach(a => {
            const name = a.full_name || `${a.first_name} ${a.last_name}`.trim();
            if (name) administratorNames.push(`${name} (${a.position || 'N/A'})`);
          });
        }
        
        if (result.ultimate_beneficiaries && Array.isArray(result.ultimate_beneficiaries)) {
          result.ultimate_beneficiaries.forEach(b => {
            const name = b.full_name || `${b.first_name} ${b.last_name}`.trim();
            if (name) beneficiaryNames.push(`${name} (${b.voting_rights || 'N/A'})`);
          });
        }
        
        const enrichedData = {
          company_name_input: company.name,
          req_name_official: result.name_official || result.req_name_official,
          NEQ: result.NEQ || null,
          status: result.status || 'Unknown',
          legal_form: result.legal_form || this.extractLegalForm(result.name_official),
          head_office_address: result.address || result.head_office_address || null,
          source_registry: result.source || 'REQ',
          match_score: result.match_score.toFixed(3),
          match_method: result.match_method,
          shareholder_1: shareholderNames[0] || '',
          shareholder_2: shareholderNames[1] || '',
          shareholder_3: shareholderNames[2] || '',
          administrator_1: administratorNames[0] || '',
          administrator_2: administratorNames[1] || '',
          administrator_3: administratorNames[2] || '',
          beneficiary_1: beneficiaryNames[0] || '',
          beneficiary_2: beneficiaryNames[1] || '',
          beneficiary_3: beneficiaryNames[2] || '',
          total_shareholders: shareholderNames.length,
          total_administrators: administratorNames.length,
          total_beneficiaries: beneficiaryNames.length,
          fetched_at: new Date().toISOString()
        };
        
        await this.cacheManager.set('enriched', cacheKey, enrichedData);
        await this.auditLogger.logSnapshot(result.NEQ || normalizedName, result);
        
        if (result.shareholders || result.administrators || result.ultimate_beneficiaries) {
          this.ownershipExporter.addCompanyOwnership({
            ...enrichedData,
            shareholders: result.shareholders,
            administrators: result.administrators,
            ultimate_beneficiaries: result.ultimate_beneficiaries
          });
        }
        
        this.enrichedResults.push(enrichedData);
        this.stats.matched++;
        
        logger.info(`✓ Matched: ${company.name} → ${result.name_official}`);
        
        return enrichedData;
      } else {
        const unmatchedData = {
          company_name_input: company.name,
          reason: result ? 'Low match score' : 'Not found'
        };
        
        this.unmatchedResults.push(unmatchedData);
        this.stats.unmatched++;
        
        logger.warn(`✗ Unmatched: ${company.name}`);
        
        return null;
      }
    } catch (error) {
      logger.error(`Error processing ${company.name}: ${error.message}`);
      this.stats.errors++;
      
      this.unmatchedResults.push({
        company_name_input: company.name,
        reason: `Error: ${error.message}`
      });
      
      return null;
    }
  }

  async searchREQ(company, normalizedName) {
    try {
      const variations = this.normalizer.generateVariations(normalizedName);
      
      let bestMatch = null;
      let bestScore = 0;
      
      for (const variation of variations) {
        const cached = await this.cacheManager.get('req', variation);
        let searchResults;
        
        if (cached && !this.options.noCache) {
          searchResults = cached;
        } else {
          searchResults = await this.reqScraper.search(variation);
          await this.cacheManager.set('req', variation, searchResults);
        }
        
        if (searchResults && searchResults.length > 0) {
          for (const reqResult of searchResults) {
            const matchResult = this.matchingEngine.match(
              normalizedName,
              reqResult.name,
              company.hintCity,
              reqResult.city
            );
            
            if (matchResult.score > bestScore) {
              bestScore = matchResult.score;
              bestMatch = {
                ...reqResult,
                match_score: matchResult.score,
                match_method: matchResult.method,
                source: 'REQ'
              };
            }
          }
        }
      }
      
      return bestMatch;
    } catch (error) {
      logger.error(`REQ search error for ${normalizedName}: ${error.message}`);
      return null;
    }
  }

  async searchCorpCan(company, normalizedName) {
    try {
      if (!normalizedName.match(/\d{7}\s+CANADA|CANADA\s+(CORP|INC|LTD)/i)) {
        return null;
      }
      
      const cached = await this.cacheManager.get('corp_can', normalizedName);
      let searchResults;
      
      if (cached && !this.options.noCache) {
        searchResults = cached;
      } else {
        searchResults = await this.corpCanScraper.search(normalizedName);
        await this.cacheManager.set('corp_can', normalizedName, searchResults);
      }
      
      if (searchResults && searchResults.length > 0) {
        let bestMatch = null;
        let bestScore = 0;
        
        for (const corpResult of searchResults) {
          const matchResult = this.matchingEngine.match(
            normalizedName,
            corpResult.name,
            company.hintCity,
            corpResult.city
          );
          
          if (matchResult.score > bestScore) {
            bestScore = matchResult.score;
            bestMatch = {
              ...corpResult,
              match_score: matchResult.score,
              match_method: matchResult.method,
              source: 'CORP_CAN'
            };
          }
        }
        
        return bestMatch;
      }
      
      return null;
    } catch (error) {
      logger.error(`Corporations Canada search error for ${normalizedName}: ${error.message}`);
      return null;
    }
  }

  checkPublicBody(company, normalizedName) {
    const publicPatterns = [
      /^VILLE\s+DE?\s+/i,
      /^MUNICIPALIT[EÉ]/i,
      /^OFF(ICE)?\.\s*MUN(ICIPAL)?\.\s*(D[''])?HAB(ITATION)?/i,
      /^OMH\s+/i,
      /^UNIVERSIT[EÉ]/i,
      /^C[EÉ]GEP/i
    ];
    
    for (const pattern of publicPatterns) {
      if (pattern.test(normalizedName)) {
        return {
          name_official: company.name,
          NEQ: null,
          status: 'Active',
          legal_form: 'public_body',
          source: 'OTHER',
          match_score: 1.0,
          match_method: 'exact'
        };
      }
    }
    
    return null;
  }

  extractLegalForm(name) {
    const forms = {
      'INC': 'Société par actions (Inc.)',
      'LTÉE': 'Société par actions (Ltée)',
      'S.E.N.C': 'Société en nom collectif',
      'S.E.C': 'Société en commandite',
      'FIDUCIE': 'Fiducie',
      'COOP': 'Coopérative'
    };
    
    const upperName = name.toUpperCase();
    for (const [key, value] of Object.entries(forms)) {
      if (upperName.includes(key)) {
        return value;
      }
    }
    
    return 'Autre';
  }

  async saveResults() {
    const { output } = this.options;
    
    if (this.enrichedResults.length > 0) {
      const enrichedCsv = csvStringify(this.enrichedResults, { header: true });
      fs.writeFileSync(output, enrichedCsv);
      logger.info(`✓ Saved ${this.enrichedResults.length} enriched records to ${output}`);
    }
    
    if (this.unmatchedResults.length > 0) {
      const unmatchedPath = output.replace('.csv', '_unmatched.csv');
      const unmatchedCsv = csvStringify(this.unmatchedResults, { header: true });
      fs.writeFileSync(unmatchedPath, unmatchedCsv);
      logger.info(`✓ Saved ${this.unmatchedResults.length} unmatched records to ${unmatchedPath}`);
    }
    
    if (this.ownershipExporter.allShareholders.length > 0 || 
        this.ownershipExporter.allAdministrators.length > 0 ||
        this.ownershipExporter.allBeneficiaries.length > 0) {
      const baseFilename = path.basename(output, '.csv');
      await this.ownershipExporter.exportAll(baseFilename);
    }
    
    const duration = (Date.now() - this.stats.startTime) / 1000;
    const matchRate = ((this.stats.matched / this.stats.total) * 100).toFixed(1);
    
    logger.info('═══════════════════════════════════════');
    logger.info('Processing Complete!');
    logger.info(`Total: ${this.stats.total}`);
    logger.info(`Matched: ${this.stats.matched} (${matchRate}%)`);
    logger.info(`Unmatched: ${this.stats.unmatched}`);
    logger.info(`Duration: ${duration.toFixed(1)}s`);
    logger.info('═══════════════════════════════════════');
  }

  async run() {
    try {
      await this.auditLogger.initialize();
      
      const companies = await this.loadInputFile();
      this.stats.total = companies.length;
      
      const tasks = companies.map(company => 
        this.limit(() => this.processCompany(company))
      );
      
      await Promise.all(tasks);
      
      await this.saveResults();
      
      await this.reqScraper.close();
      await this.corpCanScraper.close();
      
    } catch (error) {
      logger.error(`Fatal error: ${error.message}`);
      process.exit(1);
    }
  }
}

program
  .name('req-enrichment')
  .version('1.0.0')
  .requiredOption('--in <file>', 'Input file')
  .requiredOption('--col <n>', 'Column name')
  .requiredOption('--out <file>', 'Output file')
  .option('--sheet <n>', 'Excel sheet')
  .option('--concurrency <n>', 'Concurrent requests', parseInt, 2)
  .option('--rate-limit <n>', 'Requests per second', parseFloat, 1)
  .option('--timeout <ms>', 'Timeout', parseInt, 30000)
  .option('--proxy <url>', 'Proxy URL')
  .option('--strict', 'Strict matching')
  .option('--snapshot', 'Save snapshots')
  .option('--no-cache', 'Disable cache')
  .option('--no-extract-ownership', 'Skip ownership')
  .parse(process.argv);

const options = {
  input: program.opts().in,
  sheet: program.opts().sheet,
  columnName: program.opts().col,
  output: program.opts().out,
  concurrency: program.opts().concurrency,
  rateLimit: program.opts().rateLimit,
  timeout: program.opts().timeout,
  proxy: program.opts().proxy,
  strict: program.opts().strict,
  snapshot: program.opts().snapshot,
  noCache: program.opts().noCache,
  extractOwnership: program.opts().extractOwnership
};

const tool = new EnterpriseEnrichmentTool(options);
tool.run();