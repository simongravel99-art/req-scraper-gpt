# REQ Company Scraper

A robust, stealth-focused scraper for the Quebec Enterprise Registry (REQ) with comprehensive anti-blocking measures and deep observability.

## Features

### 🛡️ Anti-Blocking & Stealth
- **Ultra-conservative rate limiting**: 5 requests/minute (configurable)
- **Random delays**: 15-25 seconds between requests
- **Extended page load delays**: 8+ seconds to let pages fully render
- **Human-like form interactions**: Random delays, gradual typing
- **Proxy rotation**: Automatic rotation from proxy pool file
- **Browser fingerprint randomization**: Random viewports, User-Agents
- **Realistic headers**: French Canadian locale, proper accept headers

### 📊 Deep Observability
- **Structured JSON logging**: All actions logged to `logs/run-TIMESTAMP.jsonl`
- **Failure artifacts**: HTML snapshots + screenshots saved to `debug/failures/`
- **Request tracing**: Full request/response headers (when `--trace` enabled)
- **Metrics dashboard**: Success rates, block detection, latency tracking
- **Ambiguous match detection**: Companies with multiple matches logged separately

### 🏢 Company Processing
- **CSV input**: Read companies from `entreprises.csv` (or custom path)
- **Smart matching**: Levenshtein distance + exact match prioritization
- **Configurable columns**: Specify company name column
- **Batch processing**: `--limit N` for testing/smoke runs
- **Multiple outputs**: JSONL + CSV formats

## Quick Start

### 1. Setup
```bash
make setup
# OR manually:
npm install
mkdir -p logs debug/failures debug/samples output
```

### 2. Configuration
```bash
cp .env.example .env
# Edit .env for your needs
```

### 3. Basic Usage
```bash
# Process first 3 companies with debug logging
node index.js run --companies-csv entreprises.csv --limit 3 --debug

# Full production run
node index.js run --companies-csv entreprises.csv --debug
```

### 4. With Proxy Pool
```bash
# Create proxy file (see proxies.txt.example)
cp proxies.txt.example proxies.txt
# Edit proxies.txt with your proxies

# Run with proxy rotation
node index.js run --companies-csv entreprises.csv --limit 5 --debug --proxy-pool proxies.txt
```

## Configuration (.env)

### Stealth & Rate Limiting
```env
MAX_CONCURRENCY=1                    # Single worker for stealth
REQUESTS_PER_MINUTE=5               # Very conservative rate
MIN_DELAY_BETWEEN_REQUESTS_MS=15000 # Minimum delay
MAX_DELAY_BETWEEN_REQUESTS_MS=25000 # Maximum delay
PAGE_LOAD_DELAY_MS=8000             # Wait for pages to load
FORM_INTERACTION_DELAY_MS=3000      # Delay before form submission
```

### Proxy Settings
```env
PROXY_POOL_FILE=proxies.txt         # Path to proxy pool
```

### Debug Settings
```env
DEBUG_LEVEL=info
ENABLE_SCREENSHOTS=true
SAVE_FAILED_RESPONSES=true
TRACE_REQUESTS=false                # Set to true for full request logs
```

## CLI Commands

### Main Command
```bash
node index.js run [options]

Options:
  --companies-csv <file>     CSV file with company names (required)
  --name-column <column>     Column index/name for companies (default: 0)
  --limit <number>           Process only first N companies
  --debug                    Enable debug logging + failure artifacts
  --trace                    Enable full request/response tracing
  --proxy-pool <file>        Path to proxy pool file
  --output-dir <dir>         Output directory (default: output)
```

### Probe Command (TODO)
```bash
node index.js probe --url <url> --debug
```

## Output Files

- `output/req_results.jsonl` - Main results (one JSON per line)
- `output/req_results.csv` - Same data in CSV format
- `output/ambiguous.csv` - Companies with multiple matches
- `logs/run-TIMESTAMP.jsonl` - Structured debug logs
- `debug/failures/TIMESTAMP-*.html` - Failed page snapshots
- `debug/failures/TIMESTAMP-*.png` - Failed page screenshots

## Proxy Setup

Create `proxies.txt` with one proxy per line:
```
http://proxy1.example.com:8080
socks5://user:pass@proxy2.example.com:1080
```

Supported formats:
- `http://host:port`
- `http://user:pass@host:port`
- `socks5://host:port`
- `socks5://user:pass@host:port`

## Example Results

### JSON Output
```json
{
  "search_query": "BOMBARDIER INC.",
  "match_confidence": 0.95,
  "NEQ": "1234567890",
  "name_official": "BOMBARDIER INC.",
  "status": "Immatriculée",
  "legal_form": "Compagnie",
  "registration_date": "1985-01-15",
  "head_office_address": "800 RENÉ-LÉVESQUE BLVD. WEST, MONTREAL, QC",
  "scraped_at": "2025-09-13T14:30:45.123Z"
}
```

### Metrics Summary
```
=== SCRAPING SUMMARY ===
Duration: 12m 34s
Pages: 10 attempted, 9 succeeded (90.0%)
Blocks: 0.0% rate (403: 0, 429: 0, 5xx: 1)
Retries: 2
Average latency: 8,234ms
Output rows: 9
Ambiguous matches: 1
```

## Troubleshooting

### Common Issues

**Hanging on CSV read**: Check CSV encoding and format
**Browser launch fails**: Run `npx playwright install chromium`
**High block rate**: Increase delays in `.env`, add more proxies
**No results found**: Check REQ website structure, update selectors

### Debug Mode
Always run with `--debug` to see detailed logs and save failure artifacts.

### Selector Updates
If REQ website changes, update selectors in `lib/req-scraper.js`:
- Search input: `findSearchInput()` method
- Result parsing: `parseSearchResults()` method
- Detail extraction: `extractDetailedInfo()` method

## Architecture

```
index.js                 # CLI entry point
├── lib/
│   ├── csv-processor.js    # CSV reading and parsing
│   ├── request-layer.js    # HTTP client with anti-blocking
│   ├── debug-logger.js     # Structured logging and metrics
│   └── req-scraper.js      # Main scraping logic
├── .env                    # Configuration
├── logs/                   # Debug logs
├── debug/                  # Failure artifacts
└── output/                 # Results
```

## Performance Notes

- **Extremely slow by design**: 15-25 second delays between requests
- **Single-threaded**: One request at a time to avoid detection
- **Memory efficient**: Streams data, doesn't load everything in memory
- **Fault tolerant**: Retries with backoff, saves progress incrementally

This scraper prioritizes stealth over speed. Expect ~3-5 companies per minute.