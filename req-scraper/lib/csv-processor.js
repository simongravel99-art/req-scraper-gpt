import { parse } from 'csv-parse';
import fs from 'fs-extra';

export class CSVProcessor {
  constructor(options = {}) {
    this.options = {
      nameColumn: options.nameColumn || 0, // Default to first column
      skipHeader: options.skipHeader || false,
      encoding: options.encoding || 'utf-8',
      logger: options.logger || console
    };
  }

  async readCompanies(csvPath, limit = null) {
    try {
      const csvContent = await fs.readFile(csvPath, this.options.encoding);

      // Check if this is a simple text list (no commas) or actual CSV
      const lines = csvContent.split(/\r?\n/);
      const hasCommas = lines.some(line => line.includes(','));

      if (!hasCommas) {
        // Handle as simple text list
        this.options.logger.info(`Processing as simple text list (no CSV structure detected)`);
        return this.processTextList(lines, limit);
      }

      return new Promise((resolve, reject) => {
        const companies = [];
        const parser = parse({
          delimiter: ',',
          skip_empty_lines: true,
          trim: true,
          quote: '"',
          escape: '"'
        });

        parser.on('readable', () => {
          let record;
          let rowIndex = 0;

          while ((record = parser.read()) !== null) {
            // Skip header if configured
            if (rowIndex === 0 && this.options.skipHeader) {
              rowIndex++;
              continue;
            }

            // Extract company name based on column index or name
            const companyName = this.extractCompanyName(record);

            if (companyName && companyName.trim()) {
              companies.push({
                name: companyName.trim(),
                originalRow: record,
                rowIndex: rowIndex
              });

              // Apply limit if specified
              if (limit && companies.length >= limit) {
                break;
              }
            }

            rowIndex++;
          }
        });

        parser.on('error', (error) => {
          this.options.logger.error(`CSV parsing error: ${error.message}`);
          reject(error);
        });

        parser.on('end', () => {
          this.options.logger.info(`Loaded ${companies.length} companies from ${csvPath}`);
          resolve(companies);
        });

        parser.write(csvContent);
        parser.end();
      });

    } catch (error) {
      this.options.logger.error(`Failed to read CSV file: ${error.message}`);
      throw error;
    }
  }

  processTextList(lines, limit = null) {
    const companies = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines or lines that are too short
      if (!line || line.length < 3) continue;

      companies.push({
        name: line,
        originalRow: [line],
        rowIndex: i
      });

      // Apply limit if specified
      if (limit && companies.length >= limit) {
        break;
      }
    }

    this.options.logger.info(`Loaded ${companies.length} companies from text list`);
    return companies;
  }

  extractCompanyName(record) {
    // Handle both column index and column name
    if (typeof this.options.nameColumn === 'number') {
      return record[this.options.nameColumn];
    } else if (typeof this.options.nameColumn === 'string') {
      // For named columns, we'd need header row - for now assume index 0
      return record[0];
    }

    return record[0]; // Default to first column
  }

  normalizeCompanyName(name) {
    if (!name) return '';

    return name
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[^\w\s&.-]/g, '') // Remove special chars except common business ones
      .toUpperCase();
  }

  async writeAmbiguous(ambiguousMatches, outputPath) {
    try {
      const csvHeader = 'company_name,search_query,match_count,matches\n';
      const csvRows = ambiguousMatches.map(match => {
        const matches = match.matches.map(m => `"${m.name}"`).join(';');
        return `"${match.companyName}","${match.searchQuery}",${match.matches.length},"${matches}"`;
      }).join('\n');

      await fs.writeFile(outputPath, csvHeader + csvRows);
      this.options.logger.info(`Wrote ${ambiguousMatches.length} ambiguous matches to ${outputPath}`);
    } catch (error) {
      this.options.logger.error(`Failed to write ambiguous matches: ${error.message}`);
    }
  }
}