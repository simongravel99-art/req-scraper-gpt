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
  }

  async initialize() {
    if (this.browser) return;
    
    const launchOptions = {
      headless: this.options.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    
    if (this.options.proxy) {
      launchOptions.proxy = this.parseProxy(this.options.proxy);
    }
    
    this.browser = await chromium.launch(launchOptions);
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      locale: 'fr-CA',
      timezoneId: 'America/Montreal'
    });
  }

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

  async search(companyName, attempt = 0) {
    await this.initialize();
    
    return this.rateLimiter(async () => {
      await this.enforceRateLimit();
      
      try {
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
    // Nouvelle URL
    await page.goto('https://www.registreentreprises.gouv.qc.ca/reqna/gr/gr03/gr03a71.rechercheregistre.mvc/gr03a71/recherchenomentreprise', {
      waitUntil: 'networkidle',
      timeout: this.options.timeout
    });
    
    // Attendre que la page charge
    await page.waitForTimeout(2000);
    
    // Remplir le champ de recherche
    await page.fill('input[type="text"]', companyName);
    
    // Cocher la case des conditions
    await page.check('input[type="checkbox"]');
    
    // Cliquer sur Rechercher
    await page.click('button:has-text("Rechercher"), input[value="Rechercher"]');
    
    // Attendre les résultats
    await page.waitForSelector('button:has-text("Consulter")', { timeout: 10000 });
    
    // Cliquer sur le premier bouton Consulter
    const consultButtons = await page.$$('button:has-text("Consulter")');
    if (consultButtons.length > 0) {
      await consultButtons[0].click();
      
      // Attendre la page de détails
      await page.waitForSelector('text="Identification de l\'entreprise"', { timeout: 10000 });
      
      // Extraire les données
      const data = await page.evaluate(() => {
        const result = {};
        
        // NEQ
        const neqRow = document.querySelector('td:has-text("Numéro d\'entreprise du Québec")');
        if (neqRow) {
          result.NEQ = neqRow.nextElementSibling?.textContent?.trim();
        }
        
        // Nom
        const nameRow = document.querySelector('td:has-text("Nom")');
        if (nameRow) {
          result.name_official = nameRow.nextElementSibling?.textContent?.trim();
        }
        
        // Statut
        const statusRow = document.querySelector('td:has-text("Statut")');
        if (statusRow) {
          result.status = statusRow.nextElementSibling?.textContent?.trim();
        }
        
        // Forme juridique
        const formRow = document.querySelector('td:has-text("Forme juridique")');
        if (formRow) {
          result.legal_form = formRow.nextElementSibling?.textContent?.trim();
        }
        
        // Adresse
        const addressRow = document.querySelector('td:has-text("Adresse") + td');
        if (addressRow) {
          result.head_office_address = addressRow.textContent?.trim();
        }
        
        return result;
      });
      
      return [data];
    }
    
    return [];
    
  } catch (error) {
    this.options.logger.error(`Error searching REQ for ${companyName}:`, error);
    throw error;
  } finally {
    await page.close();
  }
}

  async parseSearchResults(page) {
    const results = await page.evaluate(() => {
      const rows = document.querySelectorAll('.k1-grille-ligne');
      const data = [];
      
      rows.forEach((row, index) => {
        if (index === 0) return;
        
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
          const neqLink = cells[0].querySelector('a');
          const neq = neqLink ? neqLink.textContent.trim() : cells[0].textContent.trim();
          const name = cells[1].textContent.trim();
          const otherNames = cells[2].textContent.trim();
          const address = cells[3].textContent.trim();
          
          data.push({
            NEQ: neq,
            name: name,
            name_official: name,
            other_names: otherNames,
            address: address,
            status: 'Unknown'
          });
        }
      });
      
      return data;
    });
    
    return results;
  }

  async getDetailedInfo(page, basicInfo, resultIndex) {
    try {
      // CLICK ON "CONSULTER" BUTTON INSTEAD OF NEQ LINK
      const consultButtons = await page.$$('a:has-text("Consulter"), button:has-text("Consulter")');
      
      if (!consultButtons[resultIndex]) {
        return basicInfo;
      }
      
      const [newPage] = await Promise.all([
        this.context.waitForEvent('page'),
        consultButtons[resultIndex].click()
      ]);
      
      await newPage.waitForLoadState('networkidle');
      
      const detailedInfo = await this.extractDetailedInfo(newPage);
      
      await newPage.close();
      
      return {
        ...basicInfo,
        ...detailedInfo,
        source: 'REQ'
      };
      
    } catch (error) {
      this.options.logger.warn(`Could not get detailed info for ${basicInfo.name}:`, error.message);
      return basicInfo;
    }
  }

  async extractDetailedInfo(page) {
    const info = await page.evaluate(() => {
      const data = {};
      
      const getText = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.trim() : null;
      };
      
      data.NEQ = getText('#CPH_K1ZoneContenu1_Cadr_IdEntreprise span');
      data.name_official = getText('#CPH_K1ZoneContenu1_Cadr_NomEntreprise span');
      
      const statusText = getText('#CPH_K1ZoneContenu1_Cadr_StatutEntreprise span');
      data.status = statusText && (statusText.includes('Immatriculée') || statusText.includes('Active')) ? 'Active' : statusText;
      
      data.legal_form = getText('#CPH_K1ZoneContenu1_Cadr_FormeJuridique span');
      
      const addressSections = document.querySelectorAll('.k1-section-adresse');
      addressSections.forEach(section => {
        const title = section.querySelector('h3');
        if (title && title.textContent.includes('Adresse du siège')) {
          const addressLines = section.querySelectorAll('.k1-ligne-adresse span');
          const addressParts = [];
          addressLines.forEach(line => {
            const text = line.textContent.trim();
            if (text) addressParts.push(text);
          });
          data.head_office_address = addressParts.join(', ');
        }
      });
      
      data.registration_date = getText('#CPH_K1ZoneContenu1_Cadr_DateImmatriculation span');
      
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
        
        // Extract sections with ownership info
        const sections = document.querySelectorAll('section, div[class*="section"]');
        
        sections.forEach(section => {
          const sectionText = section.textContent;
          
          // Shareholders
          if (sectionText.includes('Actionnaires')) {
            const shareholderMatches = sectionText.match(/Nom\s*:\s*([^\n]+)/g);
            if (shareholderMatches) {
              shareholderMatches.forEach(match => {
                const name = match.replace(/Nom\s*:\s*/, '').trim();
                data.shareholders.push({
                  name: name,
                  is_majority: sectionText.includes('majoritaire')
                });
              });
            }
          }
          
          // Administrators
          if (sectionText.includes('Administrateurs')) {
            const adminMatches = sectionText.match(/Nom de famille\s*:\s*([^\n]+)[\s\S]*?Prénom\s*:\s*([^\n]+)/g);
            if (adminMatches) {
              adminMatches.forEach(match => {
                const parts = match.match(/Nom de famille\s*:\s*([^\n]+)[\s\S]*?Prénom\s*:\s*([^\n]+)/);
                if (parts) {
                  data.administrators.push({
                    last_name: parts[1].trim(),
                    first_name: parts[2].trim(),
                    full_name: `${parts[2].trim()} ${parts[1].trim()}`
                  });
                }
              });
            }
          }
          
          // Ultimate beneficiaries
          if (sectionText.includes('Bénéficiaires ultimes')) {
            const beneficiaryMatches = sectionText.match(/Nom de famille\s*:\s*([^\n]+)[\s\S]*?Prénom\s*:\s*([^\n]+)/g);
            if (beneficiaryMatches) {
              beneficiaryMatches.forEach(match => {
                const parts = match.match(/Nom de famille\s*:\s*([^\n]+)[\s\S]*?Prénom\s*:\s*([^\n]+)/);
                if (parts) {
                  data.ultimate_beneficiaries.push({
                    last_name: parts[1].trim(),
                    first_name: parts[2].trim(),
                    full_name: `${parts[2].trim()} ${parts[1].trim()}`
                  });
                }
              });
            }
          }
        });
        
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
    this.options.logger.debug(`Snapshot saved for: ${identifier}`);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }

}
