cat > scripts/run.sh << 'EOF'
#!/bin/bash

INPUT=${1:-data/entreprises.csv}
OUTPUT=${2:-output/results.csv}

echo "🔍 Starting REQ Scraper..."
echo "📄 Input: $INPUT"
echo "💾 Output: $OUTPUT"

xvfb-run -a node index.js \
  --in "$INPUT" \
  --col company_name \
  --out "$OUTPUT" \
  --concurrency 1 \
  --rate-limit 0.5

echo "✅ Scraping complete!"
EOF

chmod +x scripts/run.sh