import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { pool } from "../../db/pool.js";
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

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

// CSV export functionality
const CSV_FILE_PATH = path.join(process.cwd(), 'req_extracted_data.csv');

async function appendToCSV(extractedData, companyName) {
  try {
    // Check if file exists to determine if we need headers
    let fileExists = false;
    try {
      await fs.access(CSV_FILE_PATH);
      fileExists = true;
    } catch (error) {
      // File doesn't exist, we'll create it with headers
    }

    // Prepare CSV headers with BOM for proper UTF-8 encoding
    const headers = [
      'Company_Name',
      'NEQ',
      'Company_Address_Business',
      'Company_Address_Elected_Domicile',
      'Person_Type',
      'Last_Name',
      'First_Name',
      'Full_Name',
      'Start_Date',
      'Functions',
      'Address',
      'Ownership_Percentage',
      'Voting_Rights',
      'Shareholder_Type',
      'Extraction_Date'
    ].join(',') + '\n';

    // Create CSV rows from extracted data
    const csvRows = [];
    const extractionDate = new Date().toISOString().split('T')[0];
    const company = extractedData.company || {};

    // Add company identification info to each person record
    const baseCompanyInfo = {
      Company_Name: escapeCSV(company.nom || companyName),
      NEQ: escapeCSV(company.neq || ''),
      Company_Address_Business: escapeCSV(company.adresse_affaires || ''),
      Company_Address_Elected_Domicile: escapeCSV(company.adresse_domicile_elu || ''),
      Extraction_Date: extractionDate
    };

    // Process people data - extractedData.people is an object with arrays
    const people = extractedData.people || {};
    const allPeople = [
      ...(people.shareholders || []),
      ...(people.administrators || []),
      ...(people.officers || []),
      ...(people.ultimate_beneficiaries || [])
    ];

    allPeople.forEach(person => {
      const row = [
        baseCompanyInfo.Company_Name,
        baseCompanyInfo.NEQ,
        baseCompanyInfo.Company_Address_Business,
        baseCompanyInfo.Company_Address_Elected_Domicile,
        escapeCSV(person.type || ''),
        escapeCSV(person.nom_famille || ''),
        escapeCSV(person.prenom || ''),
        escapeCSV(person.nom_complet || `${person.prenom || ''} ${person.nom_famille || ''}`.trim()),
        escapeCSV(person.date_debut || ''),
        escapeCSV(person.fonctions || ''),
        escapeCSV(person.adresse || ''),
        escapeCSV(person.ownership_percentage || ''),
        escapeCSV(person.voting_rights || ''),
        escapeCSV(person.shareholder_type || ''),
        baseCompanyInfo.Extraction_Date
      ];

      csvRows.push(row.join(','));
    });

    // If no people found, still add company info
    if (csvRows.length === 0) {
      const row = [
        baseCompanyInfo.Company_Name,
        baseCompanyInfo.NEQ,
        baseCompanyInfo.Company_Address_Business,
        baseCompanyInfo.Company_Address_Elected_Domicile,
        '', // Person_Type
        '', // Last_Name
        '', // First_Name
        '', // Full_Name
        '', // Start_Date
        '', // Functions
        '', // Address
        '', // Ownership_Percentage
        '', // Voting_Rights
        '', // Shareholder_Type
        baseCompanyInfo.Extraction_Date
      ];
      csvRows.push(row.join(','));
    }

    // Write to file with proper UTF-8 encoding
    const csvContent = csvRows.join('\n') + '\n';

    if (!fileExists) {
      // Create file with UTF-8 BOM and headers
      const utf8BOM = '\uFEFF';
      await fs.writeFile(CSV_FILE_PATH, utf8BOM + headers + csvContent, 'utf8');
      console.log(`✓ Created CSV file: ${CSV_FILE_PATH}`);
    } else {
      // Append to existing file
      await fs.appendFile(CSV_FILE_PATH, csvContent, 'utf8');
    }

    console.log(`✓ Added ${csvRows.length} record(s) to CSV for company: ${companyName}`);

  } catch (error) {
    console.error('Error writing to CSV:', error.message);
  }
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

export default async function reqStealthRotateSimple({ project, url, companyName }) {
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

    // Launch browser with proxy server and stealth config
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-plugins',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

    // === DATA USAGE OPTIMIZATION ===
    // Block images, stylesheets, fonts, and other unnecessary assets to reduce bandwidth
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const blockedTypes = ['image', 'stylesheet', 'font', 'media', 'manifest', 'other'];

      if (blockedTypes.includes(resourceType)) {
        console.log(`🚫 Blocked ${resourceType}: ${req.url().substring(0, 100)}...`);
        req.abort();
      } else {
        req.continue();
      }
    });

    // Add realistic human-like delay before starting
    const initialDelay = randomDelay(2, 5);
    console.log(`Waiting ${initialDelay/1000}s before starting...`);
    await new Promise(r => setTimeout(r, initialDelay));

    // Step 1: Go directly to REQ portal (skip Quebec.ca navigation)
    console.log('Step 1: Going directly to REQ portal...');

    try {
      await page.goto('https://www.registreentreprises.gouv.qc.ca/reqna/gr/gr03/gr03a71.rechercheregistre.mvc/gr03a71?choixdomaine=RegistreEntreprisesQuebec', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      console.log('Step 1 SUCCESS: REQ portal loaded directly');
      console.log('Loaded URL:', page.url());
      console.log('Page title:', await page.title());

      // Human-like delay after page load
      const pageLoadDelay = randomDelay(3, 6);
      console.log(`Waiting ${pageLoadDelay/1000}s after page load...`);
      await new Promise(r => setTimeout(r, pageLoadDelay));

    } catch (error) {
      console.log('Step 1 FAILED:', error.message);
      console.log('Current URL:', page.url());

      // Save the page content for debugging
      const content = await page.content();
      console.log('Page content preview:', content.substring(0, 500));

      throw error;
    }

    // Step 2: Fill search form on REQ portal
    console.log('Step 2: Filling company search form...');

    // Wait for JavaScript to load the form - try multiple approaches
    console.log('Waiting for page JavaScript to fully load...');

    // Try waiting for different load states
    try {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
      console.log('Document ready state: complete');
    } catch (e) {
      console.log('Document ready state wait failed:', e.message);
    }

    console.log('REQ Portal URL:', page.url());
    console.log('REQ Portal title:', await page.title());

    const bodyText = await page.evaluate(() => document.body.textContent.substring(0, 200));
    console.log('Page body text preview:', bodyText);

    // Check if we're rate limited first
    if (bodyText.includes('temporairement interdit') || bodyText.includes('utilisation excessive')) {
      console.log('RATE LIMITED detected - will retry with next proxy');
      throw new Error('Rate limited by Quebec servers - need fresh proxy');
    }

    // Look for all input fields
    const allInputs = await page.$$eval('input', inputs =>
      inputs.map(input => ({
        id: input.id,
        name: input.name,
        type: input.type,
        placeholder: input.placeholder
      }))
    );
    console.log('All input fields found:', allInputs);

    // Look for any element containing "objet"
    const objetElements = await page.$$eval('*', elements =>
      elements.filter(el =>
        el.id && el.id.toLowerCase().includes('objet') ||
        el.name && el.name.toLowerCase().includes('objet') ||
        el.className && el.className.toLowerCase().includes('objet')
      ).map(el => ({
        tag: el.tagName,
        id: el.id,
        name: el.name,
        className: el.className
      }))
    );
    console.log('Elements with "objet":', objetElements);

    // Try to find the company name input field
    let companyInput = await page.$('#Objet');
    console.log('Found #Objet input:', !!companyInput);

    if (!companyInput) {
      console.log('Trying alternative selectors...');

      // Try other possible selectors
      const selectors = [
        'input[name="Objet"]',
        'input[placeholder*="nom"]',
        'input[placeholder*="raison"]',
        'input[placeholder*="entreprise"]',
        'input[type="text"]'
      ];

      for (const selector of selectors) {
        companyInput = await page.$(selector);
        if (companyInput) {
          console.log(`Found input with selector: ${selector}`);
          break;
        }
      }
    }

    if (!companyInput) {
      console.log('No search input found, checking if page content loaded properly...');
      const pageContent = await page.content();
      console.log('Page content length:', pageContent.length);
      console.log('Page content preview:', pageContent.substring(0, 2000));

      throw new Error('Could not find search input field after trying multiple selectors');
    }

    // Fill the company name
    console.log(`Typing company name: ${companyName}`);
    await companyInput.click();
    await new Promise(r => setTimeout(r, 500)); // Brief pause after click

    // Clear field first, then type faster
    await companyInput.evaluate(input => input.value = '');
    await companyInput.type(companyName, { delay: 100 }); // Fixed faster delay
    console.log(`Successfully typed: ${companyName}`);

    // Look for and check the acknowledgment checkbox
    console.log('Looking for acknowledgment checkbox...');

    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      console.log('Found checkbox, checking it...');
      await new Promise(r => setTimeout(r, randomDelay(1, 2)));
      await checkbox.click();
    } else {
      console.log('No checkbox found - continuing without it');
    }

    // Wait a bit before searching
    const searchDelay = randomDelay(2, 4);
    console.log(`Waiting ${searchDelay/1000}s before searching...`);
    await new Promise(r => setTimeout(r, searchDelay));

    // Find and click search button
    console.log('Looking for search button...');

    let searchButton = await page.$('input[value*="Rechercher"]');
    if (!searchButton) {
      searchButton = await page.$('button[type="submit"]');
    }
    if (!searchButton) {
      searchButton = await page.$('input[type="submit"]');
    }

    if (!searchButton) {
      throw new Error('Could not find search button');
    }

    console.log('Clicking search button...');
    await searchButton.click();

    // Wait for results to load
    console.log('Waiting for search results...');
    await new Promise(r => setTimeout(r, randomDelay(5, 8)));

    // Check for results
    console.log('Checking search results...');
    console.log('Results URL:', page.url());
    console.log('Results title:', await page.title());

    const resultsContent = await page.evaluate(() => document.body.textContent);

    if (resultsContent.includes('temporairement interdit')) {
      throw new Error('Rate limited during search - need fresh proxy');
    }

    if (resultsContent.includes('Aucun résultat') || resultsContent.includes('No results')) {
      console.log('No search results found for company:', companyName);
      return { status: 'no_results', company: companyName };
    }

    // Step 3: Find the specific company and its Consulter button
    console.log(`Step 3: Looking for company match: ${companyName}`);

    // Helper function to normalize company names for matching
    const normalizeCompanyName = (name) => {
      return name
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/['']/g, "'") // Normalize quotes
        .replace(/[^\w\s']/g, ' ') // Replace special chars with space
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
    };

    const normalizedSearchName = normalizeCompanyName(companyName);

    // Find all company names (h4 elements) and use positional matching with Consulter buttons
    const companyMatches = await page.evaluate((searchCompanyName, normalizedSearch, normalizeFunc) => {
      // Recreate normalize function in browser context
      const normalize = new Function('name', normalizeFunc.toString().split('=>')[1]);

      const companies = [];
      const h4Elements = document.querySelectorAll('h4');

      // Get all Consulter buttons on the page
      const allConsulterButtons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'))
        .filter(btn => btn.textContent.includes('Consulter'));

      console.log(`Found ${h4Elements.length} h4 elements and ${allConsulterButtons.length} Consulter buttons`);

      h4Elements.forEach((h4, index) => {
        const companyNameText = h4.textContent.trim();

        // Skip non-company names (like "Types de recherche")
        const isCompanyName = !companyNameText.toLowerCase().includes('type') &&
                             !companyNameText.toLowerCase().includes('recherche') &&
                             companyNameText.length > 5; // Reasonable company name length

        let hasButton = false;
        if (isCompanyName) {
          // Use positional matching: assume buttons appear in same order as companies
          const buttonIndex = companies.filter(c => c.isCompany).length; // Count of actual companies so far
          hasButton = buttonIndex < allConsulterButtons.length;
        }

        // Check for flexible match using normalized names
        const normalizedCompanyName = normalize(companyNameText);
        const isFlexibleMatch = normalizedCompanyName === normalizedSearch;

        const company = {
          name: companyNameText,
          hasConsulterButton: hasButton,
          fuzzyMatch: isFlexibleMatch,
          isCompany: isCompanyName,
          buttonIndex: isCompanyName ? companies.filter(c => c.isCompany).length : -1
        };

        companies.push(company);
      });

      return companies;
    }, companyName, normalizedSearchName, normalizeCompanyName.toString());

    console.log('Found companies with details:', JSON.stringify(companyMatches.slice(0, 5), null, 2));
    console.log(`Total companies analyzed: ${companyMatches.length}`);

    // Debug: Show all buttons found on the page
    const allPageButtons = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"], a.btn');
      return Array.from(buttons).slice(0, 10).map(btn => ({
        tag: btn.tagName,
        text: btn.textContent.trim().substring(0, 50),
        value: btn.value || '',
        classes: btn.className,
        hasConsulter: btn.textContent.includes('Consulter') || (btn.value && btn.value.includes('Consulter'))
      }));
    });
    console.log('All page buttons found:', JSON.stringify(allPageButtons, null, 2));

    // Find flexible match (normalized)
    const flexibleMatch = companyMatches.find(company => company.fuzzyMatch);

    if (!flexibleMatch) {
      console.log(`No flexible match found for: ${companyName}`);
      console.log(`Normalized search: "${normalizedSearchName}"`);
      console.log('Available company names:', companyMatches.map(c => c.name).slice(0, 10));
      return {
        status: 'no_flexible_match',
        company: companyName,
        normalized_search: normalizedSearchName,
        available_companies: companyMatches.map(c => c.name).slice(0, 10)
      };
    }

    if (!flexibleMatch.hasConsulterButton) {
      throw new Error(`Found company "${flexibleMatch.name}" but no associated Consulter button`);
    }

    console.log(`✓ Found flexible match: ${flexibleMatch.name}`);

    // Step 4: Click the Consulter button for the matched company using positional matching
    console.log('Step 4: Clicking Consulter button for matched company...');

    // Use the buttonIndex from the Step 3 analysis instead of recalculating
    const targetCompany = companyMatches.find(company => company.fuzzyMatch === true);
    if (!targetCompany) {
      throw new Error(`Could not find target company in matches: ${companyName}`);
    }
    console.log(`Looking for button directly associated with company: ${targetCompany.name}`);

    const clicked = await page.evaluate((targetCompanyName) => {
      // Find all elements that contain the exact target company name
      const allElements = Array.from(document.querySelectorAll('*'));
      let targetCompanyElement = null;

      for (const el of allElements) {
        const text = el.textContent || '';
        // Look for exact match of the company name (trim both to handle whitespace)
        if (text.trim() === targetCompanyName.trim() && el.children.length === 0) {
          targetCompanyElement = el;
          console.log(`Found target company element: ${el.tagName} with text: "${text.trim()}"`);
          break;
        }
      }

      if (!targetCompanyElement) {
        console.log(`Could not find element containing exact text: "${targetCompanyName}"`);
        // Fallback: look for elements containing the company name
        for (const el of allElements) {
          const text = el.textContent || '';
          if (text.includes(targetCompanyName) && el.children.length <= 2) {
            targetCompanyElement = el;
            console.log(`Found fallback company element: ${el.tagName} with text: "${text.trim()}"`);
            break;
          }
        }
      }

      if (!targetCompanyElement) {
        return { success: false, error: 'Company element not found' };
      }

      // Look for a Consulter button that's associated with this company element
      // Check the company element and its parent/grandparent containers
      const searchElements = [
        targetCompanyElement,
        targetCompanyElement.parentElement,
        targetCompanyElement.parentElement?.parentElement,
        targetCompanyElement.parentElement?.parentElement?.parentElement
      ].filter(Boolean);

      let consulterButton = null;
      for (const searchEl of searchElements) {
        const buttons = searchEl.querySelectorAll('button, input[type="submit"], a.btn, a[href*="Consulter"]');
        for (const btn of buttons) {
          if (btn.textContent.includes('Consulter')) {
            consulterButton = btn;
            console.log(`Found Consulter button in ${searchEl.tagName} container`);
            break;
          }
        }
        if (consulterButton) break;

        // Also check siblings of the search element
        if (searchEl.parentElement) {
          const siblings = Array.from(searchEl.parentElement.children);
          for (const sibling of siblings) {
            const siblingButtons = sibling.querySelectorAll('button, input[type="submit"], a.btn, a[href*="Consulter"]');
            for (const btn of siblingButtons) {
              if (btn.textContent.includes('Consulter')) {
                consulterButton = btn;
                console.log(`Found Consulter button in sibling ${sibling.tagName}`);
                break;
              }
            }
            if (consulterButton) break;
          }
        }
        if (consulterButton) break;
      }

      if (!consulterButton) {
        console.log(`Could not find Consulter button associated with ${targetCompanyName}`);
        return { success: false, error: 'Button not found near company' };
      }

      // Get context for debugging
      const context = consulterButton.closest('tr') || consulterButton.closest('div') || consulterButton.parentElement;
      const contextText = context ? context.textContent : 'no context';

      console.log(`About to click Consulter button for: ${targetCompanyName}`);
      console.log(`Button context: ${contextText.substring(0, 200).replace(/\s+/g, ' ').trim()}`);

      consulterButton.click();
      return { success: true, contextText: contextText.substring(0, 200) };
    }, targetCompany.name);

    if (!clicked.success) {
      throw new Error(`Could not click Consulter button for company: ${companyName}`);
    }

    console.log('✓ Successfully clicked Consulter button');
    console.log('Button context was:', clicked.contextText);

    // Wait for company details page to load
    await new Promise(r => setTimeout(r, randomDelay(3, 5)));

    console.log('Company details page loaded');
    console.log('Final URL:', page.url());
    console.log('Final page title:', await page.title());

    // Step 5: Extract People Information and Company Identification
    console.log('Step 5: Extracting company and people information...');

    const extractedData = await page.evaluate(() => {
      // === TARGETED ELEMENT EXTRACTION ===
      // Instead of downloading entire page text, target only relevant sections
      let fullText = '';

      // Try to find specific content areas first (more efficient)
      const targetSelectors = [
        '[class*="content"]',
        '[class*="main"]',
        '[id*="content"]',
        '[class*="info"]',
        'main',
        'section',
        'article'
      ];

      let contentFound = false;
      for (const selector of targetSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          fullText = Array.from(elements).map(el => el.textContent || '').join(' ');
          if (fullText.length > 1000) { // Only use if substantial content
            console.log(`✅ Using targeted extraction with selector: ${selector} (${fullText.length} chars)`);
            contentFound = true;
            break;
          }
        }
      }

      // Fallback to body text only if targeted extraction failed
      if (!contentFound) {
        fullText = document.body.textContent || '';
        console.log(`⚠️ Fallback to full body text (${fullText.length} chars)`);
      }

      // Helper function to parse concatenated text with field patterns
      function parsePersonData(text) {
        const people = [];

        // Pattern to find person blocks - they usually start with a name or contain key fields
        const personSections = [];

        // Find all text blocks containing person-related keywords
        const lines = text.split('\n').filter(line => line.trim().length > 0);
        let currentSection = '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();

          // If we find a person-related pattern, start collecting
          if (line.includes('Nom de famille') || line.includes('Premier actionnaire') ||
              line.includes('Deuxième actionnaire') || line.includes('Prénom:')) {
            if (currentSection.length > 20) {
              personSections.push(currentSection);
            }
            currentSection = line;
          } else if (currentSection && (line.includes('Prénom') || line.includes('Date du début') ||
                     line.includes('Fonctions') || line.includes('Adresse du domicile') ||
                     line.includes('droits de vote'))) {
            currentSection += ' ' + line;
          } else if (currentSection && line.length > 50) {
            // Long line might contain concatenated data
            currentSection += ' ' + line;
          }
        }

        // Add the last section
        if (currentSection.length > 20) {
          personSections.push(currentSection);
        }

        // Parse each person section
        for (const section of personSections) {
          const person = {};

          // Extract name - improved to handle various formats
          const nomMatch = section.match(/(?:Nom de famille:?\s*)?([A-ZÀ-Ÿ][a-zA-ZÀ-ÿ\s'-]+?)(?:Prénom|Date du début|\s|$)/);
          if (nomMatch) person.nom_famille = nomMatch[1].trim();

          // Extract first name - more precise pattern
          const prenomMatch = section.match(/Prénom:?\s*([A-ZÀ-Ÿ][a-zA-ZÀ-ÿ'-]+?)(?:Date du début|Adresse|Fonctions|\s|$)/);
          if (prenomMatch) person.prenom = prenomMatch[1].trim();

          // Extract date - same pattern works well
          const dateMatch = section.match(/Date du début de la charge:?\s*(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) person.date_debut = dateMatch[1].trim();

          // Extract functions - improved to capture full titles
          const fonctionsMatch = section.match(/Fonctions actuelles:?\s*([A-ZÀ-Ÿ][a-zA-ZÀ-ÿ\s'-]+?)(?:Adresse|Nom de famille|$)/);
          if (fonctionsMatch) person.fonctions = fonctionsMatch[1].trim();

          // Extract address - improved patterns for better extraction
          let addressFound = false;

          // Try multiple address patterns to catch all formats
          const addressPatterns = [
            // Professional address (priority when personal address isn't available)
            /Adresse professionnelle[:\s]*([^N]*?)(?=Nom de famille|Premier|Deuxième|Adresse|information3|$)/,
            // Personal domicile address
            /Adresse du domicile[:\s]*([^N]*?)(?=Nom de famille|Premier|Deuxième|Adresse professionnelle|$)/,
            // Generic address patterns
            /Adresse[:\s]*([^N]*?)(?=Nom de famille|Premier|Deuxième|information3|$)/,
            /(?:domicile|Adresse)[:\s]*([0-9][^N]*?)(?=Nom|Premier|Deuxième|information3|$)/,
            /(\d+[^N]*?(?:Canada|Québec)[^N]*?)(?=Nom|Premier|Deuxième|information3|$)/
          ];

          for (const pattern of addressPatterns) {
            const adresseMatch = section.match(pattern);
            if (adresseMatch && adresseMatch[1].trim().length > 10) {
              let extractedAddress = adresseMatch[1].trim()
                .replace(/\s+/g, ' ')
                .replace(/information3.*$/g, '') // Remove system text
                .trim();

              // Skip if address is marked as not publishable
              if (extractedAddress.includes('non publiable') || extractedAddress.includes('Adresse non publiable')) {
                continue; // Try next pattern
              }

              if (extractedAddress.length > 0) {
                person.adresse = extractedAddress;
                addressFound = true;
                break;
              }
            }
          }

          // Fallback: if no address found but section contains street patterns
          if (!addressFound) {
            const streetPattern = /(\d+.*?(?:rue|avenue|boulevard|ch\.|chemin).*?(?:Canada|Québec).*?[A-Z]\d[A-Z]\d[A-Z]\d)/i;
            const streetMatch = section.match(streetPattern);
            if (streetMatch) {
              person.adresse = streetMatch[1].trim().replace(/\s+/g, ' ');
            }
          }

          // Handle special case for shareholders that start with "Premier actionnaire"
          if (section.includes('Premier actionnaire') || section.includes('Deuxième actionnaire')) {
            person.type = 'shareholder';
            person.shareholder_type = section.includes('Premier') ? 'premier' : 'deuxième';

            // If name wasn't parsed yet, try to extract from shareholder pattern
            if (!person.nom_famille) {
              const actionnaireNameMatch = section.match(/(?:Premier|Deuxième) actionnaire.*?([A-ZÀ-Ÿ][a-zA-ZÀ-ÿ\s'-]+?)(?:Prénom|Adresse|$)/);
              if (actionnaireNameMatch) {
                person.nom_famille = actionnaireNameMatch[1].trim();
              }
            }
          } else if (section.includes('droits de vote')) {
            person.type = 'ultimate_beneficiary';
            const droitsMatch = section.match(/(\d+)\s*%\s*à\s*(\d+)\s*%/);
            if (droitsMatch) {
              person.voting_rights = `${droitsMatch[1]}% à ${droitsMatch[2]}%`;
            }
          } else if (person.fonctions || person.date_debut) {
            person.type = 'administrator';
          }

          // Only add if we have meaningful data
          if (person.nom_famille || person.prenom) {
            people.push(person);
          }
        }

        return people;
      }

      // Extract Company Identification
      const company = {};

      // NEQ
      const neqMatch = fullText.match(/Numéro d'entreprise du Québec \(NEQ\):\s*(\d+)/);
      if (neqMatch) company.neq = neqMatch[1];

      // Company Name
      const nomMatch = fullText.match(/NEQ\):\s*\d+\s*Nom:\s*([^\n]*?)(?=\s*Adresse|$)/);
      if (nomMatch) company.nom = nomMatch[1].trim();

      // Business Address
      const adresseMatch = fullText.match(/Adresse du domicile\s*Adresse:\s*([^\n]*?)(?=\s*Adresse du domicile élu|$)/);
      if (adresseMatch) company.adresse_affaires = adresseMatch[1].trim();

      // Elected Domicile Address
      const domicileMatch = fullText.match(/Adresse du domicile élu\s*Adresse:\s*([^\n]*?)(?=\s*Immatriculation|$)/);
      if (domicileMatch) company.adresse_domicile_elu = domicileMatch[1].trim();

      // Extract People Information
      const people = parsePersonData(fullText);

      // Categorize people by type
      const shareholders = people.filter(p => p.type === 'shareholder');
      const administrators = people.filter(p => p.type === 'administrator');
      const ultimateBeneficiaries = people.filter(p => p.type === 'ultimate_beneficiary');
      const officers = people.filter(p => p.fonctions && !p.type) || administrators;

      return {
        company: company,
        people: {
          shareholders: shareholders,
          administrators: administrators,
          officers: officers,
          ultimate_beneficiaries: ultimateBeneficiaries,
          all_people: people
        },
        debug: {
          full_text_sample: fullText.substring(0, 2000),
          total_people_found: people.length,
          extraction_successful: true
        }
      };
    });

    console.log('=== EXTRACTION RESULTS ===');
    console.log('Company:', JSON.stringify(extractedData.company, null, 2));
    console.log(`People found: ${extractedData.debug.total_people_found}`);
    console.log('Shareholders:', JSON.stringify(extractedData.people.shareholders, null, 2));
    console.log('Administrators:', JSON.stringify(extractedData.people.administrators, null, 2));
    console.log('Officers/Directors:', JSON.stringify(extractedData.people.officers, null, 2));
    console.log('Ultimate Beneficiaries:', JSON.stringify(extractedData.people.ultimate_beneficiaries, null, 2));
    console.log('=== END EXTRACTION ===');

    // Export to CSV
    await appendToCSV(extractedData, companyName);

    return {
      status: 'success',
      company: companyName,
      matched_company: flexibleMatch.name,
      final_url: page.url(),
      details_page_loaded: true,
      extracted_data: {
        company_identification: extractedData.company,
        people_information: extractedData.people,
        extraction_debug: extractedData.debug
      }
    };

  } catch (error) {
    console.log(`Error processing ${companyName}:`, error.message);

    // Update database with error
    try {
      await pool.query(
        'UPDATE jobs SET data = data || $1 WHERE data->>\'companyName\' = $2 AND data->>\'status\' IS NULL',
        [JSON.stringify({ status: 'error', error: error.message, timestamp: new Date().toISOString() }), companyName]
      );
    } catch (dbError) {
      console.log('Database update error:', dbError.message);
    }

    throw error;
  } finally {
    if (browser) {
      try {
        console.log('Browser closed successfully');
        await browser.close();
      } catch (e) {
        console.log('Error closing browser:', e.message);
      }
    }
  }
}