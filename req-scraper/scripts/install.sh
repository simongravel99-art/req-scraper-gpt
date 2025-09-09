mkdir scripts
cat > scripts/install.sh << 'EOF'
#!/bin/bash

echo "📦 Installing REQ Scraper..."

# Install Node dependencies
npm install

# Install Playwright
npx playwright install chromium
npx playwright install-deps chromium

# Create directories
mkdir -p output
mkdir -p .cache
mkdir -p audit/logs

# Copy env file
cp .env.example .env

echo "✅ Installation complete!"
echo "📝 Edit .env file if needed"
echo "🚀 Run with: npm run scrape"
EOF

chmod +x scripts/install.sh