import { chromium } from 'playwright';
import pLimit from 'p-limit';
import { setTimeout } from 'timers/promises';

export class REQScraper {
  constructor(options = {}) {
    this.options = {
      headless: true,
      timeout: options.timeout || 30000,
      rateLimit: options.rateLimit || 1000,
      maxRetries: 3,
      snapshot: options.snapshot || false,
      proxy: options.proxy,
      logger: options.logger || console,
      extractOwnership: options.extractOwnership !== false
    };
    
    this.browser = null;
    this.context = null;
    this.rateLimiter = pLimit(1);
    this.lastRequestTime = 0;
    this.retryDelays = [500, 1500, 3500];
    this.sessionCounter = 0; // For forcing proxy rotation
  }

  async initialize(forceNewSession = false) {
    // Force new browser session for proxy rotation
    if (this.browser && forceNewSession) {
      await this.close();
    }
    
    if (this.browser) return;
    
    this.sessionCounter++;
    
    const launchOptions = {
      headless: this.options.headless,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        `--user-data-dir=/tmp/chrome-session-${this.sessionCounter}` // Force new session
      ]
    };
    
    if (this.options.proxy) {
      launchOptions.proxy = this.parseProxy(this.options.proxy);
    }
    
 this.browser = await chromium.launch(launchOptions);
this.context = await this.browser.newContext({
  viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  locale: 'fr-CA',
  timezoneId: 'America/Montreal'
});
    
  parseProxy(proxyUrl) {
    const url = new URL(proxyUrl);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined
    };
  }

  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.options.rateLimit) {
      await setTimeout(this.options.rateLimit - timeSinceLastRequest);
    }
    
    this.lastRequestTime = Date.now();
  }

  async checkIPAndAccess() {
    const page = await this.context.newPage();
    try {
      // Check current IP
      await page.goto('https://httpbin.org/ip', { waitUntil: 'networkidle', timeout: 10000 });
      const ipResponse = await page.textContent('body');
      const currentIP = JSON.parse(ipResponse).origin;
      this.options.logger.info(`Using IP: ${currentIP}`);
      
      // Test Quebec site accessibility
      await page.goto('https://www.registreentreprises.gouv.qc.ca/REQNA/GR/GR03/GR03A71.RechercheRegistre.MVC/GR03A71', {
        waitUntil: 'networkidle',
        timeout: 15000
      });
      
      const content = await page.textContent('body');
      const isBlocked = content.includes('temporairement interdit');
      
      if (isBlocked) {
        this.options.logger.warn(`IP ${currentIP} is blocked, attempting rotation...`);
        await page.close();
        return false;
      }
      
      this.options.logger.info(`IP ${currentIP} is accessible`);
      await page.close();
      return true;
      
    } catch (error) {
      this.options.logger.error(`IP check failed: ${error.message}`);
      await page.close();
      return false;
    }
  }

  async search(companyName, attempt = 0) {
    // Initialize with potential proxy rotation
    await this.initialize(attempt > 0);
    
    return this.rateLimiter(async () => {
      await this.enforceRateLimit();
      
      try {
        // Check if current IP is accessible before searching
        const isAccessible = await this.checkIPAndAccess();
        if (!isAccessible && attempt < this.options.maxRetries) {
          // Force new session to get new IP
          await this.close();
          const delay = this.retryDelays[attempt] + (Math.random() * 5000); // Add randomness
          this.options.logger.warn(`Rotating proxy and retrying in ${delay}ms...`);
          await setTimeout(delay);
          return this.search(companyName, attempt + 1);
        }
        
        if (!isAccessible) {
          throw new Error('All IPs blocked, cannot access Quebec registry');
        }
        
        return await this.performSearch(companyName);
      } catch (error) {
        if (attempt < this.options.maxRetries) {
          const delay = this.retryDelays[attempt];
          this.options.logger.warn(`REQ search failed, retrying in ${delay}ms...`, error.message);
          await setTimeout(delay);
          return this.search(companyName, attempt + 1);
        }
        throw error;
      }
    });
  }

  async performSearch(companyName) {
    const page = await this.context.newPage();
    page.setDefaultTimeout(this.options.timeout);
    
    try {
      // Go directly to the enterprise search page
      await page.goto('https://www.registreentreprises.gouv.qc.ca/REQNA/GR/GR03/GR03A71.RechercheRegistre.MVC/GR03A71', {
        waitUntil: 'networkidle',
        timeout: 60000
      });
      
      // Double-check we're not blocked
      const content = await page.textContent('body');
      if (content.includes('temporairement interdit')) {
        throw new Error('IP blocked during search');
      }
      
      // Wait for page to fully load
      await page.waitForTimeout(3000);
      
      // Look for the search form - try multiple possible selectors
      const searchSelectors = [
        'input[name="Nom"]',
        'input[placeholder*="nom"]',
        'input[type="text"]',
        '#Nom',
        '[data-testid="search-input"]'
      ];
      
      let searchInput = null;
      for (const selector of searchSelectors) {
        try {
          searchInput = await page.waitForSelector(selector, { timeout: 5000 });
          if (searchInput) {
            this.options.logger.debug(`Found search input with selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!searchInput) {
        searchInput = await page.$('input[type="text"]');
      }
      
      if (!searchInput) {
        throw new Error('Search input field not found');
      }
      
      // Clear and fill the search field
      await searchInput.click();
      await searchInput.clear();
      await searchInput.fill(companyName);
      
      // Look for and click submit button
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Rechercher")',
        'input[value*="Rechercher"]',
        '.btn-primary',
        '[data-testid="search-button"]'
      ];
      
      let submitButton = null;
      for (const selector of submitSelectors) {
        try {
          submitButton = await page.$(selector);
          if (submitButton) {
            this.options.logger.debug(`Found submit button with selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!submitButton) {
        await searchInput.press('Enter');
      } else {
        await submitButton.click();
      }
      
      // Wait for results to load
      await page.waitForTimeout(5000);
      
      // Try to detect if we have results
      const resultSelectors = [
        'table tbody tr',
        '.result-row',
        '.search-result',
        '[data-testid="result-row"]',
        'tr:has(td)',
        '.table tr'
      ];
      
      let results = [];
      for (const selector of resultSelectors) {
        try {
          const rows = await page.$$(selector);
          if (rows.length > 0) {
            this.options.logger.debug(`Found ${rows.length} result rows with selector: ${selector}`);
            results = await this.parseSearchResultsWithSelector(page, selector);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (results.length === 0) {
        const linkSelectors = [
          'a:has-text("Consulter")',
          'button:has-text("Consulter")',
          'a[href*="NEQ"]',
          'a[href*="entreprise"]',
          '.action-link'
        ];
        
        for (const selector of linkSelectors) {
          try {
            const links = await page.$$(selector);
            if (links.length > 0) {
              this.options.logger.debug(`Found ${links.length} action links with selector: ${selector}`);
              results = await this.extractBasicInfoFromPage(page, links);
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      if (results.length === 0) {
        if (this.options.snapshot) {
          const html = await page.content();
          await this.saveSnapshot(`no-results-${companyName}`, html);
        }
        this.options.logger.warn(`No results found for ${companyName}`);
        return [];
      }
      
      return results;
      
    } catch (error) {
      this.options.logger.error(`Error searching REQ for ${companyName}:`, error);
      
      if (this.options.snapshot) {
        try {
          const html = await page.content();
          await this.saveSnapshot(`error-${companyName}`, html);
        } catch (e) {
          // Ignore snapshot errors
        }
      }
      
      throw error;
    } finally {
      await page.close();
    }
  }

  async parseSearchResultsWithSelector(page, selector) {
    return await page.evaluate((sel) => {
      const rows = document.querySelectorAll(sel);
      const results = [];
      
      for (const row of rows) {
        if (row.querySelector('th')) continue;
        
        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;
        
        let neq = '', name = '', address = '';
        
        for (let i = 0; i < cells.length; i++) {
          const cellText = cells[i].textContent.trim();
          
          if (/^\d{10}/.test(cellText)) {
            neq = cellText;
          }
          
          if (cellText.length > name.length && !cellText.match(/^\d/) && cellText.length > 10) {
            name = cellText;
          }
          
          if (cellText.includes('RUE') || cellText.includes('AVENUE') || cellText.includes('BOULEVARD')) {
            address = cellText;
          }
        }
        
        if (name) {
          results.push({
            NEQ: neq,
            name: name,
            name_official: name,
            address: address,
            status: 'Unknown'
          });
        }
      }
      
      return results;
    }, selector);
  }

  async extractBasicInfoFromPage(page, actionLinks) {
    const results = [];
    
    const pageData = await page.evaluate(() => {
      const results = [];
      
      const textElements = document.querySelectorAll('td, .company-name, .result-item');
      
      for (const element of textElements) {
        const text = element.textContent.trim();
        
        if (text.match(/(INC|LTÉE|LTEE|CORP|S\.E\.N\.C)/i) && text.length > 5) {
          results.push({
            NEQ: '',
            name: text,
            name_official: text,
            address: '',
            status: 'Unknown'
          });
        }
      }
      
      return results;
    });
    
    return pageData;
  }

  async extractDetailedInfo(page) {
    const info = await page.evaluate(() => {
      const data = {};
      
      const getText = (selectors) => {
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element) return element.textContent.trim();
        }
        return null;
      };
      
      data.NEQ = getText([
        '#CPH_K1ZoneContenu1_Cadr_IdEntreprise span',
        '[data-field="neq"]',
        '.neq',
        'span:contains("NEQ")'
      ]);
      
      data.name_official = getText([
        '#CPH_K1ZoneContenu1_Cadr_NomEntreprise span',
        '[data-field="name"]',
        '.company-name',
        'h1',
        'h2'
      ]);
      
      data.status = getText([
        '#CPH_K1ZoneContenu1_Cadr_StatutEntreprise span',
        '[data-field="status"]',
        '.status'
      ]);
      
      data.legal_form = getText([
        '#CPH_K1ZoneContenu1_Cadr_FormeJuridique span',
        '[data-field="legal-form"]',
        '.legal-form'
      ]);
      
      const addressElements = document.querySelectorAll('.address, .adresse, [data-field="address"]');
      if (addressElements.length > 0) {
        const addressParts = [];
        addressElements.forEach(el => {
          const text = el.textContent.trim();
          if (text) addressParts.push(text);
        });
        data.head_office_address = addressParts.join(', ');
      }
      
      data.registration_date = getText([
        '#CPH_K1ZoneContenu1_Cadr_DateImmatriculation span',
        '[data-field="registration-date"]',
        '.registration-date'
      ]);
      
      return data;
    });
    
    if (this.options.extractOwnership) {
      const ownershipInfo = await this.extractOwnershipInfo(page);
      return { ...info, ...ownershipInfo };
    }
    
    return info;
  }

  async extractOwnershipInfo(page) {
    try {
      const ownership = await page.evaluate(() => {
        const data = {
          shareholders: [],
          administrators: [],
          ultimate_beneficiaries: [],
          shareholders_agreement: null
        };
        
        const allText = document.body.textContent;
        
        const shareholderMatches = allText.match(/actionnaire[s]?[:\s]+([^\.]+)/gi);
        if (shareholderMatches) {
          shareholderMatches.forEach(match => {
            const name = match.replace(/actionnaire[s]?[:\s]+/i, '').trim();
            if (name && name.length > 2) {
              data.shareholders.push({
                name: name,
                is_majority: allText.toLowerCase().includes('majoritaire')
              });
            }
          });
        }
        
        const adminMatches = allText.match(/administrateur[s]?[:\s]+([^\.]+)/gi);
        if (adminMatches) {
          adminMatches.forEach(match => {
            const name = match.replace(/administrateur[s]?[:\s]+/i, '').trim();
            if (name && name.length > 2) {
              data.administrators.push({
                full_name: name,
                position: 'Administrateur'
              });
            }
          });
        }
        
        return data;
      });
      
      return ownership;
      
    } catch (error) {
      this.options.logger.warn(`Could not extract ownership info:`, error.message);
      return {
        shareholders: [],
        administrators: [],
        ultimate_beneficiaries: [],
        shareholders_agreement: null
      };
    }
  }

  async saveSnapshot(identifier, html) {
    if (this.options.snapshot) {
      const fs = await import('fs-extra');
      const path = await import('path');
      
      const filename = `${identifier.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.html`;
      const filepath = path.join('artifacts', filename);
      
      await fs.ensureDir('artifacts');
      await fs.writeFile(filepath, html);
      
      this.options.logger.debug(`Snapshot saved: ${filepath}`);
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }
}

