import { chromium } from 'playwright';

async function testPlaywrightProxy() {
    const proxyUrl = 'http://simongravel99_gmail_com:Canisius2025@la.residential.rayobyte.com:8000';

    console.log('Testing Playwright with Rayobyte proxy...');

    // Parse proxy URL like the scraper does
    const url = new URL(proxyUrl);
    const proxyConfig = {
        server: `${url.protocol}//${url.host}`,
    };

    // Add authentication if present
    if (url.username && url.password) {
        proxyConfig.username = url.username;
        proxyConfig.password = url.password;
    }

    console.log('Proxy config:', {
        server: proxyConfig.server,
        username: proxyConfig.username?.substring(0, 5) + '***',
        hasPassword: !!proxyConfig.password
    });

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    });

    const context = await browser.newContext({
        proxy: proxyConfig,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        locale: 'fr-CA',
        timezoneId: 'America/Toronto'
    });

    const page = await context.newPage();

    try {
        console.log('Checking IP via httpbin.org...');
        await page.goto('http://httpbin.org/ip', { waitUntil: 'domcontentloaded', timeout: 10000 });
        const content = await page.content();
        console.log('Page content:', content.substring(0, 500));

    } catch (error) {
        console.error('Error testing proxy:', error.message);
    } finally {
        await browser.close();
    }
}

testPlaywrightProxy().catch(console.error);