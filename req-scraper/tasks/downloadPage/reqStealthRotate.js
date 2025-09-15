import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { pool } from "../../db/pool.js";
import { readFileSync } from 'fs';

puppeteer.use(StealthPlugin());

const proxyList = readFileSync('./proxy-list.txt', 'utf-8')
  .split('\n')
  .filter(p => p.trim());

let proxyIndex = 0;

function getNextProxy() {
  const proxy = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;
  return proxy;
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

// Enhanced delays for Quebec's aggressive rate limiting
function conservativeDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

export default async function reqStealthRotate({ project, url, companyName }) {
  console.log(`Processing company: ${companyName} with stealth rotation`);

  let browser;

  try {
    const proxyUrl = getNextProxy();
    console.log(`Using proxy ${proxyIndex}/${proxyList.length}: ${proxyUrl}`);

    // Parse the Rayobyte proxy URL correctly
    const proxyMatch = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!proxyMatch) {
      throw new Error(`Invalid proxy URL format: ${proxyUrl}`);
    }

    const [, username, password, host, port] = proxyMatch;
    console.log(`Proxy: ${host}:${port} with auth: ${username}`);

    // Launch browser with proxy server (without auth in args)
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        `--proxy-server=${host}:${port}`
      ]
    });

    const page = await browser.newPage();

    // Set up proxy authentication properly
    await page.authenticate({
      username: username,
      password: password
    });

    await page.setViewport({ width: 1920, height: 1080 });

    // Step 1: Go to Quebec.ca REQ landing page
    console.log('Step 1: Going to Quebec.ca REQ landing page...');

    try {
      await page.goto('https://www.quebec.ca/entreprises-et-travailleurs-autonomes/obtenir-renseignements-entreprise/recherche-registre-entreprises/acceder-registre-entreprises', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      console.log('Step 1 SUCCESS: Quebec.ca page loaded');
      console.log('Loaded URL:', page.url());
      console.log('Page title:', await page.title());

    } catch (error) {
      console.log('Step 1 FAILED:', error.message);
      console.log('Current URL:', page.url());

      // Save the page content for debugging
      const content = await page.content();
      console.log('Page content preview:', content.substring(0, 500));

      throw error;
    }

    await new Promise(r => setTimeout(r, randomDelay(3, 5)));

    // Step 2: Click "Accéder au service" button to get to REQ portal
    console.log('Step 2: Clicking "Accéder au service" button...');

    // DEBUG: Check what page we're actually on
    console.log('Quebec.ca page URL:', page.url());
    console.log('Quebec.ca page title:', await page.title());

    // DEBUG: Look for any links with "service" or "registre"
    const allLinks = await page.$$eval('a', links =>
      links.map(link => ({
        href: link.href,
        text: link.textContent.trim().substring(0, 50),
        hasRegistre: link.href.includes('registre') || link.textContent.includes('registre'),
        hasService: link.href.includes('service') || link.textContent.includes('service')
      })).filter(link => link.hasRegistre || link.hasService)
    );
    console.log('Found relevant links:', JSON.stringify(allLinks, null, 2));

    const accessButton = await page.$('a[href*="choixdomaine=RegistreEntreprisesQuebec"]');
    if (!accessButton) {
      console.log('Could not find button with choixdomaine=RegistreEntreprisesQuebec');

      // Try alternative selectors
      const altButton = await page.$('a[href*="registreentreprises.gouv.qc.ca"]');
      if (altButton) {
        console.log('Found alternative button with registreentreprises.gouv.qc.ca');
        throw new Error('Found alternative button - update selector');
      }

      throw new Error('Could not find "Accéder au service" button');
    }

    await accessButton.scrollIntoViewIfNeeded();

    // Handle new tab opening - wait for new target
    const newPagePromise = new Promise(resolve => {
      browser.once('targetcreated', async target => {
        const newPage = await target.page();
        resolve(newPage);
      });
    });

    // Click the button
    console.log('Clicking button...');
    await accessButton.click();
    console.log('Button clicked, waiting for new page...');

    // Wait for new page to be created (with timeout)
    const newPageTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('New page creation timed out')), 15000)
    );

    const newPage = await Promise.race([newPagePromise, newPageTimeout]);
    console.log('New page created, waiting for body...');

    // Wait for new page to load completely
    await newPage.waitForSelector('body', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 3000)); // Additional wait for full load
    console.log('New page body loaded');

    // Close the old page to free up resources
    try {
      await page.close();
    } catch (e) {
      console.log('Old page already closed:', e.message);
    }

    const reqPage = newPage; // Use new page

    // DEBUG: Check what page we actually landed on
    console.log('After clicking "Accéder au service":');
    console.log('Current URL:', reqPage.url());
    console.log('Page title:', await reqPage.title());

    await new Promise(r => setTimeout(r, randomDelay(8, 12)));

    // Step 3: Fill search form on REQ portal
    console.log('Step 3: Filling company search form...');

    // Wait for JavaScript to load the form - try multiple approaches
    console.log('Waiting for page JavaScript to fully load...');

    // Try waiting for different load states
    try {
      await reqPage.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
      console.log('Document ready state: complete');
    } catch (e) {
      console.log('Document ready state wait failed:', e.message);
    }

    // Wait for potential JavaScript form loading
    await new Promise(r => setTimeout(r, 5000));

    // DEBUG: Save the actual REQ portal page to see what we're dealing with
    console.log('REQ Portal URL:', reqPage.url());
    console.log('REQ Portal title:', await reqPage.title());

    // Check if page has any content at all
    const bodyText = await reqPage.evaluate(() => document.body.textContent.slice(0, 200));
    console.log('Page body text preview:', bodyText);

    // Look for any input fields first
    const allInputs = await reqPage.$$eval('input', inputs =>
      inputs.map(input => ({
        id: input.id,
        name: input.name,
        type: input.type,
        placeholder: input.placeholder,
        class: input.className
      }))
    ).catch(() => []);
    console.log('All input fields found:', JSON.stringify(allInputs, null, 2));

    // Look for any elements with "Objet" in the id or name
    const objetElements = await reqPage.$$eval('*', elements =>
      elements.filter(el =>
        el.id && el.id.toLowerCase().includes('objet') ||
        el.name && el.name.toLowerCase().includes('objet')
      ).map(el => ({
        tagName: el.tagName,
        id: el.id,
        name: el.name,
        type: el.type,
        className: el.className
      }))
    ).catch(() => []);
    console.log('Elements with "objet":', JSON.stringify(objetElements, null, 2));

    // Try to find the search input - first try exact match
    let searchInput = await reqPage.$('#Objet');
    console.log('Found #Objet input:', !!searchInput);

    // If not found, try other possible selectors
    if (!searchInput) {
      console.log('Trying alternative selectors...');
      const alternativeSelectors = [
        'input[name="Objet"]',
        'input[type="text"]',
        'input[id*="objet" i]',
        'input[name*="objet" i]',
        '#recherche input',
        '.search input',
        'form input[type="text"]'
      ];

      for (const selector of alternativeSelectors) {
        try {
          searchInput = await reqPage.$(selector);
          if (searchInput) {
            console.log(`Found input with selector: ${selector}`);
            break;
          }
        } catch (e) {
          console.log(`Selector ${selector} failed:`, e.message);
        }
      }
    }

    if (!searchInput) {
      console.log('No search input found, checking if page content loaded properly...');

      // Save page content for debugging
      const pageContent = await reqPage.content();
      console.log('Page content length:', pageContent.length);
      console.log('Page content preview:', pageContent.slice(0, 1000));

      throw new Error('Could not find search input field after trying multiple selectors');
    }

    // Step 4: Find and check terms checkbox
    console.log('Step 4: Checking terms and conditions checkbox...');

    const termsCheckbox = await reqPage.$('input[type="checkbox"]');
    if (termsCheckbox) {
      await termsCheckbox.scrollIntoViewIfNeeded();
      await termsCheckbox.check();
      await new Promise(r => setTimeout(r, randomDelay(1, 2)));
    }

    // Step 5: Fill company name and submit
    console.log('Step 5: Filling company name and submitting search...');

    await searchInput.click();
    await new Promise(r => setTimeout(r, randomDelay(1, 2)));
    await searchInput.fill(companyName);
    await new Promise(r => setTimeout(r, randomDelay(1, 3)));

    // Find and click search button
    const searchButton = await reqPage.$('button:has-text("Rechercher"), input[value="Rechercher"]');
    if (!searchButton) {
      throw new Error('Could not find search button');
    }

    await searchButton.click();

    // Step 6: Wait for search results to load
    console.log('Step 6: Waiting for search results...');

    await new Promise(r => setTimeout(r, randomDelay(5, 8)));

    // Wait for either results or no-results message
    try {
      await Promise.race([
        reqPage.waitForSelector('span:has-text("Consulter")', { timeout: 15000 }),
        reqPage.waitForSelector(':has-text("Aucun résultat")', { timeout: 15000 }),
        reqPage.waitForSelector(':has-text("aucune entreprise")', { timeout: 15000 })
      ]);
    } catch (error) {
      console.log('No specific results elements found, proceeding anyway');
    }

    await new Promise(r => setTimeout(r, randomDelay(2, 4)));

    // Step 7: Check for rate limiting
    const rateLimited = await reqPage.evaluate(() => {
      return document.body.textContent.includes('L\'accès à nos services vous est temporairement interdit') ||
             document.body.textContent.includes('utilisation excessive');
    });

    if (rateLimited) {
      console.log('Rate limited - will retry with different proxy');

      const companyData = {
        company_name: companyName,
        status: 'rate_limited',
        message: 'Rate limited - need different proxy',
        scraped_at: new Date().toISOString()
      };

      await pool.query(
        `UPDATE pages SET data = $1, updated_at = NOW() WHERE project = $2 AND url = $3`,
        [JSON.stringify(companyData), project, url]
      );

      return companyData;
    }

    // Step 8: Look for "Consulter" buttons and company names
    console.log('Step 8: Looking for company results...');

    const consultButtons = await reqPage.$$('span:has-text("Consulter")');

    if (consultButtons.length === 0) {
      console.log('No Consulter buttons found - may be no results');

      const companyData = {
        company_name: companyName,
        status: 'no_results',
        message: 'No search results found',
        scraped_at: new Date().toISOString()
      };

      await pool.query(
        `UPDATE pages SET data = $1, updated_at = NOW() WHERE project = $2 AND url = $3`,
        [JSON.stringify(companyData), project, url]
      );

      return companyData;
    }

    console.log(`Found ${consultButtons.length} companies with Consulter buttons`);

    // Step 9: Find best matching company and click Consulter
    console.log('Step 9: Finding best matching company...');

    let bestMatch = null;
    let bestScore = 0;

    for (let i = 0; i < consultButtons.length; i++) {
      try {
        const button = consultButtons[i];

        // Look for h4 element with company name near this button
        const parentContainer = await button.evaluateHandle(btn => {
          let element = btn;
          while (element && !['DIV', 'SECTION', 'ARTICLE', 'LI', 'TR'].includes(element.tagName)) {
            element = element.parentElement;
          }
          return element;
        });

        if (parentContainer) {
          const h4Elements = await parentContainer.$$('h4');
          if (h4Elements.length > 0) {
            const foundCompanyName = await h4Elements[0].evaluate(el => el.textContent.trim());

            // Simple matching logic - can be enhanced
            const similarity = calculateSimilarity(companyName.toLowerCase(), foundCompanyName.toLowerCase());

            if (similarity > bestScore) {
              bestScore = similarity;
              bestMatch = {
                name: foundCompanyName,
                button: button,
                index: i
              };
            }
          }
        }
      } catch (e) {
        console.log(`Error processing result ${i}: ${e.message}`);
      }
    }

    if (!bestMatch || bestScore < 0.3) {
      console.log('No good matching company found');

      const companyData = {
        company_name: companyName,
        status: 'no_match',
        message: 'No matching company found in results',
        scraped_at: new Date().toISOString()
      };

      await pool.query(
        `UPDATE pages SET data = $1, updated_at = NOW() WHERE project = $2 AND url = $3`,
        [JSON.stringify(companyData), project, url]
      );

      return companyData;
    }

    console.log(`Best match: ${bestMatch.name} (score: ${bestScore.toFixed(2)})`);

    // Step 10: Click Consulter button for best match
    console.log('Step 10: Clicking Consulter button for best match...');

    const [detailPage] = await Promise.all([
      new Promise(resolve => browser.once('targetcreated', target => resolve(target.page()))),
      bestMatch.button.click()
    ]);

    await detailPage.waitForSelector('body', { timeout: 15000 });
    await new Promise(r => setTimeout(r, randomDelay(5, 8)));

    // Step 11: Extract company details from detail page
    console.log('Step 11: Extracting company details...');

    const companyData = await detailPage.evaluate((searchedName, matchedName) => {
      // Function to extract value by label
      const getValue = (label) => {
        const text = document.body.textContent;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(label)) {
            // Try to get value from same line or next line
            if (lines[i].split(':').length > 1) {
              return lines[i].split(':').slice(1).join(':').trim();
            } else if (i + 1 < lines.length) {
              return lines[i + 1].trim();
            }
          }
        }
        return null;
      };

      return {
        searched_company: searchedName,
        matched_company: matchedName,
        neq: getValue('NEQ') || getValue('Numéro d\'entreprise'),
        status_juridique: getValue('Statut') || getValue('Forme juridique'),
        adresse: getValue('Adresse') || getValue('Siège'),
        date_immatriculation: getValue('Date d\'immatriculation') || getValue('Date de constitution'),
        secteur_activite: getValue('Secteur') || getValue('Activité'),
        scraped_at: new Date().toISOString(),
        status: 'success',
        page_url: window.location.href,
        raw_text: document.body.textContent.slice(0, 2000) // First 2000 chars for debugging
      };
    }, companyName, bestMatch.name);

    // Save successful result to database
    await pool.query(
      `UPDATE pages SET data = $1, updated_at = NOW() WHERE project = $2 AND url = $3`,
      [JSON.stringify(companyData), project, url]
    );

    console.log(`✓ Successfully scraped company: ${companyName}`);
    return companyData;

  } catch (error) {
    console.error(`Error processing ${companyName}: ${error.message}`);

    const errorData = {
      company_name: companyName,
      error: error.message,
      status: 'error',
      scraped_at: new Date().toISOString()
    };

    await pool.query(
      `UPDATE pages SET data = $1, updated_at = NOW() WHERE project = $2 AND url = $3`,
      [JSON.stringify(errorData), project, url]
    );

    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log('Browser closed successfully');
      } catch (e) {
        console.log('Error closing browser:', e.message);
      }
    }
  }
}

// Simple similarity calculation function
function calculateSimilarity(str1, str2) {
  // Remove common words and punctuation for better matching
  const clean = (str) => str.replace(/inc\.?|ltd\.?|corp\.?|,|\./gi, '').trim();
  const cleaned1 = clean(str1);
  const cleaned2 = clean(str2);

  if (cleaned1 === cleaned2) return 1.0;
  if (cleaned2.includes(cleaned1) || cleaned1.includes(cleaned2)) return 0.8;

  // Simple word overlap calculation
  const words1 = cleaned1.split(/\s+/);
  const words2 = cleaned2.split(/\s+/);
  const commonWords = words1.filter(word => words2.includes(word));

  return commonWords.length / Math.max(words1.length, words2.length);
}