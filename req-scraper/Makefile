.PHONY: setup run test clean debug probe

# Setup project dependencies and directories
setup:
	npm install
	mkdir -p logs debug/failures debug/samples output inputs tests
	@echo "✅ Project setup complete"
	@echo "📝 Copy .env.example to .env and configure your settings"

# Run the scraper with basic settings
run:
	node index.js run --companies-csv entreprises.csv --limit 10

# Run with debug enabled
debug:
	node index.js run --companies-csv entreprises.csv --limit 3 --debug --trace

# Run selector probe on a single page
probe:
	node index.js probe --url "$(URL)"

# Run tests
test:
	npm test

# Clean generated files
clean:
	rm -rf logs/* debug/failures/* debug/samples/* output/*
	@echo "🧹 Cleaned generated files"

# Development helpers
dev-test:
	node index.js run --from-list inputs/test-ids.txt --max-pages 3 --debug

install-browser:
	npx playwright install chromium