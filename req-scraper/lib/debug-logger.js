import pino from 'pino';
import fs from 'fs-extra';
import path from 'path';

export class DebugLogger {
  constructor(options = {}) {
    this.options = {
      debug: options.debug || false,
      trace: options.trace || false,
      logDir: options.logDir || 'logs',
      failureDir: options.failureDir || 'debug/failures',
      ...options
    };

    this.metrics = {
      pagesAttempted: 0,
      pagesSucceeded: 0,
      pagesFailed: 0,
      blocks: { '403': 0, '429': 0, '5xx': 0 },
      retries: 0,
      startTime: Date.now(),
      requestLatencies: [],
      outputRows: 0
    };

    this.ambiguousMatches = [];
    this.setupLogger();
  }

  setupLogger() {
    // Ensure log directories exist
    fs.ensureDirSync(this.options.logDir);
    fs.ensureDirSync(this.options.failureDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const logFile = path.join(this.options.logDir, `run-${timestamp}.jsonl`);

    const streams = [
      {
        stream: fs.createWriteStream(logFile),
        level: this.options.debug ? 'debug' : 'info'
      }
    ];

    // Add console output if not in quiet mode
    if (!this.options.quiet) {
      streams.push({
        stream: pino.destination(1), // stdout
        level: 'info'
      });
    }

    this.logger = pino({
      level: this.options.debug ? 'debug' : 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => {
          return { level: label };
        }
      }
    }, pino.multistream(streams));

    this.logger.info(`Debug logging enabled. Log file: ${logFile}`);
  }

  info(message, meta = {}) {
    this.logger.info({ ...meta }, message);
  }

  debug(message, meta = {}) {
    if (this.options.debug) {
      this.logger.debug({ ...meta }, message);
    }
  }

  warn(message, meta = {}) {
    this.logger.warn({ ...meta }, message);
  }

  error(message, meta = {}) {
    this.logger.error({ ...meta }, message);
  }

  logRequest(method, url, proxy = null) {
    this.debug(`Request: ${method} ${url}`, {
      type: 'request',
      method,
      url,
      proxy,
      timestamp: Date.now()
    });
  }

  logResponse(url, status, bytes, elapsedMs, retries = 0) {
    const meta = {
      type: 'response',
      url,
      status,
      bytes,
      elapsed_ms: elapsedMs,
      retries,
      timestamp: Date.now()
    };

    this.metrics.requestLatencies.push(elapsedMs);

    if (status >= 200 && status < 300) {
      this.debug(`Response: ${status} ${url}`, meta);
      this.metrics.pagesSucceeded++;
    } else {
      this.warn(`Response: ${status} ${url}`, meta);
      this.metrics.pagesFailed++;

      // Track specific error types
      if (status === 403) this.metrics.blocks['403']++;
      else if (status === 429) this.metrics.blocks['429']++;
      else if (status >= 500) this.metrics.blocks['5xx']++;
    }

    this.metrics.pagesAttempted++;
    this.metrics.retries += retries;
  }

  async saveFailureArtifact(url, htmlContent, screenshot = null, errorInfo = {}) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const slug = this.createSlug(url);
      const baseName = `${timestamp}-${slug}`;

      // Save HTML
      const htmlPath = path.join(this.options.failureDir, `${baseName}.html`);
      await fs.writeFile(htmlPath, htmlContent);

      // Save screenshot if provided
      if (screenshot) {
        const screenshotPath = path.join(this.options.failureDir, `${baseName}.png`);
        await fs.writeFile(screenshotPath, screenshot);
      }

      this.error(`Failure artifact saved`, {
        type: 'failure_artifact',
        url,
        htmlPath,
        screenshotPath: screenshot ? `${baseName}.png` : null,
        error: errorInfo
      });

    } catch (error) {
      this.error(`Failed to save failure artifact: ${error.message}`, { url });
    }
  }

  createSlug(url) {
    return url
      .replace(/https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 50);
  }

  logParsingStage(stage, company, result = null, error = null) {
    this.debug(`Parsing stage: ${stage}`, {
      type: 'parsing',
      stage,
      company,
      success: !error,
      result: result ? Object.keys(result) : null,
      error: error?.message
    });
  }

  logAmbiguousMatch(companyName, searchQuery, matches) {
    this.ambiguousMatches.push({
      companyName,
      searchQuery,
      matches: matches.map(m => ({ name: m.name, url: m.url }))
    });

    this.warn(`Ambiguous match for company: ${companyName}`, {
      type: 'ambiguous_match',
      company: companyName,
      search_query: searchQuery,
      match_count: matches.length,
      matches: matches.map(m => m.name)
    });
  }

  incrementOutputRows() {
    this.metrics.outputRows++;
  }

  async getMetricsSummary() {
    const endTime = Date.now();
    const duration = endTime - this.metrics.startTime;
    const avgLatency = this.metrics.requestLatencies.length > 0 ?
      this.metrics.requestLatencies.reduce((a, b) => a + b, 0) / this.metrics.requestLatencies.length : 0;

    const summary = {
      duration_ms: duration,
      duration_human: this.formatDuration(duration),
      pages: {
        attempted: this.metrics.pagesAttempted,
        succeeded: this.metrics.pagesSucceeded,
        failed: this.metrics.pagesFailed,
        success_rate: this.metrics.pagesAttempted > 0 ?
          (this.metrics.pagesSucceeded / this.metrics.pagesAttempted * 100).toFixed(1) + '%' : '0%'
      },
      blocks: this.metrics.blocks,
      block_rate: this.metrics.pagesAttempted > 0 ?
        ((this.metrics.blocks['403'] + this.metrics.blocks['429']) / this.metrics.pagesAttempted * 100).toFixed(1) + '%' : '0%',
      retries: this.metrics.retries,
      avg_latency_ms: Math.round(avgLatency),
      output_rows: this.metrics.outputRows,
      ambiguous_matches: this.ambiguousMatches.length
    };

    this.info('Scraping session summary', {
      type: 'summary',
      ...summary
    });

    return summary;
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  getAmbiguousMatches() {
    return this.ambiguousMatches;
  }
}