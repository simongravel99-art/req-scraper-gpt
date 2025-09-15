# REQ Enterprise Registry Scraper - Multi-Worker Architecture

This is the enhanced REQ scraper using your proven multi-worker architecture with Graphile Worker, proxy rotation, and stealth techniques.

## 🚀 Key Features

✅ **Proven Architecture**: Based on your working Granby scraper
✅ **Multi-Worker**: Concurrent processing with job queue
✅ **Proxy Rotation**: Automatic rotation through proxy pool
✅ **Stealth Mode**: Puppeteer-extra with stealth plugin
✅ **Rate Limiting**: Smart delays and retry logic
✅ **Complete REQ Workflow**: Quebec.ca → REQ portal → search → Consulter → details

## 🛠 Setup Instructions

### 1. Database Setup
```bash
# Copy your database credentials
cp env-example .env
# Edit .env with your PostgreSQL connection string

# Setup database schema
npm run setup
```

### 2. Install Dependencies
```bash
npm install -f package-worker.json
```

### 3. Configure Proxy Pool
Add more proxy IPs to `proxy-list.txt`:
```
http://user1:pass1@proxy1.rayobyte.com:8000
http://user2:pass2@proxy2.rayobyte.com:8000
http://user3:pass3@proxy3.rayobyte.com:8000
```

### 4. Queue Companies
```bash
npm run seed
```

### 5. Start Workers
```bash
# Start with 3 concurrent workers
npm run worker
```

## 📊 How It Works

1. **Job Queue**: Each company becomes a job in PostgreSQL queue
2. **Worker Pool**: Multiple workers process jobs concurrently
3. **Proxy Rotation**: Each job uses next proxy in rotation
4. **REQ Workflow**:
   - Navigate to Quebec.ca landing page
   - Click "Accéder au service" → REQ portal
   - Fill company name in `#Objet` input
   - Check terms checkbox
   - Submit search
   - Wait for results with `span:has-text("Consulter")` buttons
   - Find matching company in `<h4>` tags
   - Click corresponding Consulter button
   - Extract company details from detail page
   - Save to database

## 🎯 Advantages Over Single-Process

- **Scale**: Process multiple companies simultaneously
- **Resilience**: Failed jobs auto-retry with different proxies
- **Efficiency**: No waiting for single proxy cooldown
- **Monitoring**: Database tracks all attempts and results
- **Restart**: Workers can be restarted without losing progress

## 📈 Expected Results

With multiple proxies and workers, this should successfully scrape your entire `entreprises.csv` list by distributing load across different IPs and avoiding the aggressive rate limiting we encountered with single-proxy approach.

## 🔧 Scaling Up

To handle more companies faster:
1. Add more proxy IPs to `proxy-list.txt`
2. Increase `concurrency` in `main-worker.js`
3. Run multiple worker processes on different servers
4. Each worker automatically rotates through different proxies

---

**Status**: Ready for production testing with your proven multi-worker architecture! 🎉