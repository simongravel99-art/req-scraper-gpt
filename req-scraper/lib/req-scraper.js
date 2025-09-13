import { chromium } from 'playwright';
import pLimit from 'p-limit';
import { setTimeout } from 'timers/promises';
import leven from 'leven';

export class REQScraper {
  constructor(options = {}) {
    this.options = {
      headless: true,
      timeout: options.timeout || 60000,
      rateLimit: options.rateLimit || 20000, // Much slower for stealth
      pageLoadDelay: options.pageLoadDelay || 8000,
      formInteractionDelay: options.formInteractionDelay || 3000,
      maxRetries: 3,
      debug: options.debug || false,
      logger: options.logger || console,
      requestLayer: options.requestLayer
    };

    this.browser = null;
    this.context = null;
    this.rateLimiter = pLimit(1);
    this.lastRequestTime = 0;
    this.retryDelays = [500, 1500, 3500];
    this.sessionCounter = 0;
  }

  async initialize() {
    if (this.browser) return;

    this.sessionCounter++;

    const launchOptions = {
      headless: this.options.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    };

    this.browser = await chromium.launch(launchOptions);

    // Randomize viewport for stealth
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
      { width: 1536, height: 864 }
    ];
    const viewport = viewports[Math.floor(Math.random() * viewports.length)];

    // Randomize user agent
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
    ];
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    this.context = await this.browser.newContext({
      viewport,
      userAgent,
      locale: 'fr-CA',
      timezoneId: 'America/Montreal',
      // Additional stealth settings
      extraHTTPHeaders: {
        'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (this.options.debug) {
      this.options.logger.debug(`Initialized browser with viewport: ${viewport.width}x${viewport.height}, UA: ${userAgent.substring(0, 50)}...`);
    }
  }

  async searchAndScrapeCompany(companyName) {
    try {
      this.options.logger.debug(`Starting search for company: ${companyName}`);

      // Perform search
      const searchResults = await this.searchCompany(companyName);

      if (searchResults.length === 0) {
        return {
          status: 'not_found',
          reason: 'No search results found',
          searchQuery: companyName
        };
      }

      // Apply matching logic
      const bestMatch = this.selectBestMatch(companyName, searchResults);

      if (bestMatch.status === 'ambiguous') {
        return {
          status: 'ambiguous',
          searchQuery: companyName,
          matches: searchResults
        };
      }

      // Scrape detailed information
      const detailedInfo = await this.scrapeCompanyDetails(bestMatch.match);

      return {
        status: 'success',
        data: {
          search_query: companyName,
          match_confidence: bestMatch.confidence,
          ...detailedInfo
        }
      };

    } catch (error) {
      this.options.logger.error(`Failed to process company ${companyName}: ${error.message}`);

      return {
        status: 'error',
        reason: error.message,
        searchQuery: companyName
      };
    }
  }

  async searchCompany(companyName, attempt = 0) {
    await this.initialize();

    return this.rateLimiter(async () => {
      await this.enforceRateLimit();

      try {
        return await this.performSearch(companyName);
      } catch (error) {
        if (attempt < this.options.maxRetries) {
          const delay = this.retryDelays[attempt] + Math.random() * 1000;
          this.options.logger.warn(`Search failed, retrying in ${delay}ms: ${error.message}`);
          await setTimeout(delay);
          return this.searchCompany(companyName, attempt + 1);
        }
        throw error;
      }
    });
  }

  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    // Add significant random delay for stealth (15-25 seconds)
    const minDelay = 15000;
    const maxDelay = 25000;
    const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);

    const requiredDelay = Math.max(
      this.options.rateLimit - timeSinceLastRequest,
      randomDelay
    );

    if (requiredDelay > 0) {
      if (this.options.debug) {
        this.options.logger.debug(`Stealth delay: ${Math.round(requiredDelay)}ms`);
      }
      await setTimeout(requiredDelay);
    }

    this.lastRequestTime = Date.now();
  }

  async performSearch(companyName) {
    let page = await this.context.newPage();
    const startTime = Date.now();

    try {
      this.options.logger.debug(`Navigating to Quebec.ca REQ landing page`);

      // First navigate to Quebec.ca landing page
      await page.goto('https://www.quebec.ca/entreprises-et-travailleurs-autonomes/obtenir-renseignements-entreprise/recherche-registre-entreprises/acceder-registre-entreprises', {
        waitUntil: 'networkidle',
        timeout: 60000
      });

      await setTimeout(3000); // Brief wait for page to stabilize

      // Click the "Accéder au service" button to get to the actual REQ portal
      this.options.logger.debug(`Clicking "Accéder au service" button...`);

      // Find the specific button for company search
      const accessButton = await page.locator('a[href*="choixdomaine=RegistreEntreprisesQuebec"]').first();
      await accessButton.scrollIntoViewIfNeeded();

      // Since this opens in a new tab, we need to handle the new page
      const [newPage] = await Promise.all([
        this.context.waitForEvent('page'),
        accessButton.click()
      ]);

      // Switch to the new page and wait for it to load
      await newPage.waitForLoadState('networkidle');
      await page.close(); // Close the old page

      // Use the new page for the rest of the process
      page = newPage; // Reassign page variable

      // Extended wait for REQ portal to fully load
      this.options.logger.debug(`Waiting ${this.options.pageLoadDelay}ms for REQ portal to fully load...`);
      await page.waitForTimeout(this.options.pageLoadDelay);

      // Find search input
      const searchInput = await this.findSearchInput(page);
      if (!searchInput) {
        throw new Error('Could not find search input field');
      }

      // First, find and check the terms and conditions checkbox
      this.options.logger.debug(`Looking for terms and conditions checkbox...`);

      const termsCheckbox = await page.locator('input[type="checkbox"]').first();
      await termsCheckbox.scrollIntoViewIfNeeded();
      await termsCheckbox.check();

      this.options.logger.debug(`Terms checkbox checked, proceeding with search...`);
      await page.waitForTimeout(1000); // Wait after checkbox

      // Fill search form with human-like delays
      await searchInput.click();
      await page.waitForTimeout(500 + Math.random() * 1000); // Random delay after click

      // Clear field slowly and fill character by character for stealth
      await searchInput.selectText();
      await page.waitForTimeout(200);
      await searchInput.fill(companyName);

      // Wait before submitting to simulate human behavior
      await page.waitForTimeout(this.options.formInteractionDelay);

      this.options.logger.debug(`Searching for: ${companyName}`);

      // Submit search
      await this.submitSearch(page, searchInput);

      // Extended wait for results to load
      this.options.logger.debug(`Waiting for search results to load...`);
      await page.waitForTimeout(5000 + Math.random() * 3000);


      // Parse results
      const results = await this.parseSearchResults(page);

      const elapsedMs = Date.now() - startTime;
      this.options.logger.debug(`Search completed in ${elapsedMs}ms, found ${results.length} results`);

      return results;

    } catch (error) {
      const elapsedMs = Date.now() - startTime;

      // Save failure artifact if debugging
      if (this.options.debug) {
        try {
          const html = await page.content();
          const screenshot = await page.screenshot({ type: 'png' });
          await this.options.logger.saveFailureArtifact(
            `search-${companyName}`,
            html,
            screenshot,
            { error: error.message, elapsedMs }
          );
        } catch (e) {
          // Ignore artifact save errors
        }
      }

      throw error;
    } finally {
      await page.close();
    }
  }

  async findSearchInput(page) {
    // Based on the PDF, the REQ portal has specific selectors
    const selectors = [
      // REQ portal specific selectors (from PDF analysis)
      'input[name*="entreprise"]',
      'input[name*="Entreprise"]',
      'input[placeholder*="entreprise"]',
      'input[placeholder*="nom"]',
      // General fallback selectors
      'input[name*="nom"]',
      'input[id*="nom"]',
      'input[name*="Nom"]',
      'input[id*="Nom"]',
      '#ctl00_cphK1ZoneContenu1_txtNomEntreprise',
      // Very generic fallbacks
      'input[type="text"]:not([style*="display: none"])',
      'input[type="text"]'
    ];

    for (const selector of selectors) {
      try {
        const input = await page.waitForSelector(selector, { timeout: 3000 });
        if (input) {
          // Verify the input is visible and not hidden
          const isVisible = await input.isVisible();
          if (isVisible) {
            this.options.logger.debug(`Found search input with selector: ${selector}`);
            return input;
          }
        }
      } catch (e) {
        continue;
      }
    }

    return null;
  }

  async submitSearch(page, searchInput) {
    // Based on the PDF, the REQ portal has a blue "Rechercher" button
    const submitSelectors = [
      // REQ portal specific selectors
      'button:has-text("Rechercher")',
      'input[value="Rechercher"]',
      'input[value*="Rechercher"]',
      'button[value*="Rechercher"]',
      // Generic submit selectors
      'input[type="submit"]',
      'button[type="submit"]',
      'input[name*="Rechercher"]',
      '.btn-submit',
      '.button-primary',
      'button.btn'
    ];

    for (const selector of submitSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isVisible();
          if (isVisible) {
            this.options.logger.debug(`Submitting with selector: ${selector}`);
            await button.click();
            return;
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Fall back to Enter key
    this.options.logger.debug('Falling back to Enter key submission');
    await searchInput.press('Enter');
  }

  async parseSearchResults(page) {
    // Check for "no results" message first
    const noResultsSelectors = [
      ':has-text("Aucun résultat")',
      ':has-text("aucune entreprise")',
      ':has-text("0 résultat")',
      ':has-text("Aucune correspondance")',
      '.no-results'
    ];

    for (const selector of noResultsSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          this.options.logger.debug('No results message found');
          return [];
        }
      } catch (e) {
        continue;
      }
    }

    // NEW APPROACH: Find search result rows with "Consulter" buttons
    // Based on PDF: each company result has a "Consulter" link/button
    const consultButtonSelectors = [
      'a:has-text("Consulter")',
      'button:has-text("Consulter")',
      'input[value="Consulter"]',
      'a[title*="Consulter"]',
      'a:has-text("Voir")',
      'a:has-text("Détails")'
    ];

    let consultButtons = [];
    for (const selector of consultButtonSelectors) {
      try {
        const buttons = await page.$$(selector);
        if (buttons.length > 0) {
          this.options.logger.debug(`Found ${buttons.length} "Consulter" buttons with selector: ${selector}`);
          consultButtons = buttons;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (consultButtons.length === 0) {
      this.options.logger.debug('No "Consulter" buttons found - may be no results or different page structure');
      return [];
    }

    // Extract company info from each row to return for matching
    const results = [];
    for (let i = 0; i < consultButtons.length; i++) {
      try {
        // Find the parent row for this Consulter button
        const button = consultButtons[i];
        const row = await button.evaluateHandle(btn => {
          // Walk up the DOM to find the table row
          let element = btn;
          while (element && element.tagName !== 'TR') {
            element = element.parentElement;
          }
          return element;
        });

        if (row) {
          // Extract company name and other details from the row
          const rowText = await row.evaluate(tr => tr.textContent.trim());
          const cells = await row.$$('td');

          let companyName = '';
          let NEQ = '';

          // Extract text from each cell
          for (const cell of cells) {
            const cellText = await cell.evaluate(td => td.textContent.trim());

            // Look for NEQ (usually 10 digits)
            if (/^\d{10}/.test(cellText)) {
              NEQ = cellText;
            }
            // Company name is usually the longest text cell that's not a number
            else if (cellText.length > companyName.length && !/^\d/.test(cellText) && !cellText.includes('Consulter')) {
              companyName = cellText;
            }
          }

          results.push({
            name: companyName || `Company ${i + 1}`,
            NEQ: NEQ,
            rawText: rowText,
            consultButton: button,
            index: i
          });
        }
      } catch (e) {
        this.options.logger.debug(`Error extracting data from result ${i}: ${e.message}`);
        continue;
      }
    }

    this.options.logger.debug(`Parsed ${results.length} company results with Consulter buttons`);
    return results;
  }

  async extractResultData(page, selector) {
    return await page.evaluate((sel) => {
      const rows = document.querySelectorAll(sel);
      const results = [];

      for (const row of rows) {
        // Skip header rows
        if (row.querySelector('th') || row.textContent.includes('Nom de l\'entreprise')) {
          continue;
        }

        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;

        // Extract data from cells
        const data = {
          NEQ: '',
          name: '',
          status: '',
          address: '',
          detailUrl: ''
        };

        // Look for NEQ (usually first column or contains digits)
        for (let i = 0; i < cells.length; i++) {
          const cellText = cells[i].textContent.trim();

          if (/^\d{10}/.test(cellText)) {
            data.NEQ = cellText;
          }
        }

        // Look for company name (usually longest text)
        let longestText = '';
        for (let i = 0; i < cells.length; i++) {
          const cellText = cells[i].textContent.trim();

          if (cellText.length > longestText.length &&
              !cellText.match(/^\d/) &&
              cellText.length > 3) {
            longestText = cellText;
          }
        }
        data.name = longestText;

        // Look for status
        for (let i = 0; i < cells.length; i++) {
          const cellText = cells[i].textContent.trim().toLowerCase();

          if (cellText.includes('active') ||
              cellText.includes('inactive') ||
              cellText.includes('radiée') ||
              cellText.includes('immatriculée')) {
            data.status = cells[i].textContent.trim();
            break;
          }
        }

        // Look for detail link
        const detailLink = row.querySelector('a[href*="Consulter"], a[href*="NEQ"]');
        if (detailLink) {
          data.detailUrl = detailLink.href;
        }

        // Only add if we found a name
        if (data.name) {
          results.push(data);
        }
      }

      return results;
    }, selector);
  }

  selectBestMatch(searchQuery, results) {
    if (results.length === 0) {
      return { status: 'not_found' };
    }

    if (results.length === 1) {
      return {
        status: 'success',
        match: results[0],
        confidence: 1.0
      };
    }

    // Calculate match scores
    const scored = results.map(result => {
      const score = this.calculateMatchScore(searchQuery, result);
      return { ...result, matchScore: score };
    });

    // Sort by score (higher is better)
    scored.sort((a, b) => b.matchScore - a.matchScore);

    const bestScore = scored[0].matchScore;
    const secondBestScore = scored.length > 1 ? scored[1].matchScore : 0;

    // If the best match is significantly better, use it
    if (bestScore > 0.8 && (bestScore - secondBestScore) > 0.2) {
      return {
        status: 'success',
        match: scored[0],
        confidence: bestScore
      };
    }

    // Otherwise, it's ambiguous
    return {
      status: 'ambiguous',
      matches: scored.slice(0, 5) // Return top 5 matches
    };
  }

  calculateMatchScore(searchQuery, result) {
    const queryNorm = this.normalizeCompanyName(searchQuery);
    const resultNorm = this.normalizeCompanyName(result.name);

    let score = 0;

    // Exact match
    if (queryNorm === resultNorm) {
      score += 1.0;
    } else {
      // Levenshtein distance (lower is better)
      const distance = leven(queryNorm, resultNorm);
      const maxLen = Math.max(queryNorm.length, resultNorm.length);
      const similarity = 1 - (distance / maxLen);
      score += similarity * 0.8;
    }

    // Bonus for active companies
    if (result.status && result.status.toLowerCase().includes('active')) {
      score += 0.1;
    }

    // Bonus if searchQuery is contained in result
    if (resultNorm.includes(queryNorm)) {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  normalizeCompanyName(name) {
    if (!name) return '';

    return name
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s&.-]/g, '')
      .replace(/\b(INC|LTEE|LTÉE|CORP|S\.E\.N\.C|ENR)\b\.?/g, '')
      .trim();
  }

  async scrapeCompanyDetails(company) {
    if (!company.consultButton) {
      // Return basic info if no Consulter button available
      return {
        NEQ: company.NEQ,
        name_official: company.name,
        status: company.status || '',
        scraped_at: new Date().toISOString()
      };
    }

    const startTime = Date.now();

    try {
      this.options.logger.debug(`Clicking "Consulter" button for: ${company.name}`);

      // Click the Consulter button to navigate to detailed page
      // This might open in the same page or a new tab
      const [newPage] = await Promise.all([
        this.context.waitForEvent('page').catch(() => null), // Might not open new page
        company.consultButton.click()
      ]);

      // Determine which page to use
      let detailPage;
      if (newPage) {
        // New page opened
        await newPage.waitForLoadState('networkidle');
        detailPage = newPage;
        this.options.logger.debug(`Detail page opened in new tab`);
      } else {
        // Same page navigation - find the page that contains the button
        const allPages = this.context.pages();
        detailPage = allPages.find(p => p.url().includes('registreentreprises.gouv.qc.ca'));
        if (detailPage) {
          await detailPage.waitForLoadState('networkidle');
          this.options.logger.debug(`Detail page loaded in same tab`);
        }
      }

      if (!detailPage) {
        throw new Error('Could not find detail page after clicking Consulter');
      }

      // Extended wait for detail page to fully load
      this.options.logger.debug(`Waiting for detail page to fully load...`);
      await detailPage.waitForTimeout(this.options.pageLoadDelay);

      const details = await this.extractDetailedInfo(detailPage);

      const elapsedMs = Date.now() - startTime;
      this.options.logger.debug(`Detail scraping completed in ${elapsedMs}ms`);

      // Close the detail page if it's a new page
      if (newPage) {
        await newPage.close();
      }

      return {
        NEQ: company.NEQ,
        scraped_at: new Date().toISOString(),
        ...details
      };

    } catch (error) {
      this.options.logger.warn(`Failed to scrape details for ${company.name}: ${error.message}`);

      // Return basic info on failure
      return {
        NEQ: company.NEQ,
        name_official: company.name,
        status: company.status || '',
        scraped_at: new Date().toISOString(),
        scraping_error: error.message
      };
    }
  }

  async extractDetailedInfo(page) {
    return await page.evaluate(() => {
      const data = {};

      const getText = (selectors) => {
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element) {
            return element.textContent.trim();
          }
        }
        return null;
      };

      // Company name
      data.name_official = getText([
        '#ctl00_cphK1ZoneContenu1_lblNomEntreprise',
        '.company-name',
        'h1',
        'h2'
      ]);

      // Status
      data.status = getText([
        '#ctl00_cphK1ZoneContenu1_lblStatutEntreprise',
        '.status'
      ]);

      // Legal form
      data.legal_form = getText([
        '#ctl00_cphK1ZoneContenu1_lblFormeJuridique',
        '.legal-form'
      ]);

      // Registration date
      data.registration_date = getText([
        '#ctl00_cphK1ZoneContenu1_lblDateImmatriculation',
        '.registration-date'
      ]);

      // Address
      data.head_office_address = getText([
        '#ctl00_cphK1ZoneContenu1_lblAdresseSiegeSocial',
        '.address'
      ]);

      // Business number
      data.business_number = getText([
        '#ctl00_cphK1ZoneContenu1_lblNumeroEntreprise',
        '.business-number'
      ]);

      return data;
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }
}