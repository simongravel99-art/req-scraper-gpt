import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config();

async function testProxy() {
  const proxy = process.env.PROXY_URL;
  console.log('Testing proxy:', proxy ? 'configured' : 'not configured');
  
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
    console.log('Proxy server:', launchOptions.proxy.server);
    console.log('Proxy username:', launchOptions.proxy.username);
  }
  
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    // Check IP
    await page.goto('https://httpbin.org/ip', { waitUntil: 'networkidle' });
    const ipResponse = await page.textContent('body');
    console.log('Current IP response:', ipResponse);
    
    // Test Quebec site accessibility
    console.log('\nTesting Quebec site...');
    await page.goto('https://www.registreentreprises.gouv.qc.ca/REQNA/GR/GR03/GR03A71.RechercheRegistre.MVC/GR03A71', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    
    const title = await page.title();
    const content = await page.textContent('body');
    
    console.log('Page title:', title);
    console.log('Page accessible:', !content.includes('temporairement interdit'));
    
    if (content.includes('temporairement interdit')) {
      console.log('BLOCKED! Site is blocking this IP');
    } else {
      console.log('SUCCESS! Site is accessible');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
}

testProxy();
