import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config();

async function testRotation() {
  const proxy = process.env.PROXY_URL;
  
  for (let i = 0; i < 5; i++) {
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    
    if (proxy) {
      const url = new URL(proxy);
      launchOptions.proxy = {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        username: url.username || undefined,
        password: url.password || undefined
      };
    }
    
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    
    try {
      console.log(`\nAttempt ${i + 1}:`);
      
      // Check IP
      await page.goto('https://httpbin.org/ip', { waitUntil: 'networkidle' });
      const ipResponse = await page.textContent('body');
      const ip = JSON.parse(ipResponse).origin;
      console.log('IP:', ip);
      
      // Test Quebec site
      await page.goto('https://www.registreentreprises.gouv.qc.ca/REQNA/GR/GR03/GR03A71.RechercheRegistre.MVC/GR03A71', {
        waitUntil: 'networkidle',
        timeout: 15000
      });
      
      const content = await page.textContent('body');
      const isBlocked = content.includes('temporairement interdit');
      
      console.log('Status:', isBlocked ? 'BLOCKED' : 'ACCESSIBLE');
      
      if (!isBlocked) {
        console.log('🎉 Found working IP:', ip);
        break;
      }
      
    } catch (error) {
      console.log('Error:', error.message);
    } finally {
      await browser.close();
    }
    
    // Wait between attempts
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

testRotation();
