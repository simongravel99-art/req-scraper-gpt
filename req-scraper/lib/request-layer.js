import axios from 'axios';
import fs from 'fs-extra';
import { setTimeout } from 'timers/promises';
import path from 'path';

export class RequestLayer {
  constructor(options = {}) {
    this.options = {
      timeout: options.timeout || 60000,
      maxRetries: options.maxRetries || 3,
      requestsPerMinute: options.requestsPerMinute || 5,
      maxConcurrency: options.maxConcurrency || 1,
      minDelay: options.minDelay || 15000,
      maxDelay: options.maxDelay || 25000,
      proxyPoolFile: options.proxyPoolFile,
      debug: options.debug || false,
      logger: options.logger || console
    };

    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.proxies = [];
    this.currentProxyIndex = 0;
    this.retryDelays = [1000, 2000, 5000]; // Exponential backoff

    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
    ];

    this.session = axios.create({
      timeout: this.options.timeout,
      maxRedirects: 5
    });

    this.initializeSession();
  }

  async initialize() {
    if (this.options.proxyPoolFile && await fs.pathExists(this.options.proxyPoolFile)) {
      await this.loadProxies();
    }
  }

  async loadProxies() {
    try {
      const content = await fs.readFile(this.options.proxyPoolFile, 'utf-8');
      this.proxies = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(proxy => this.parseProxy(proxy));

      this.options.logger.info(`Loaded ${this.proxies.length} proxies from ${this.options.proxyPoolFile}`);
    } catch (error) {
      this.options.logger.warn(`Failed to load proxies: ${error.message}`);
    }
  }

  parseProxy(proxyString) {
    // Parse proxy formats: http://user:pass@host:port or socks5://user:pass@host:port
    const match = proxyString.match(/(https?|socks[45]?):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)/);
    if (!match) {
      throw new Error(`Invalid proxy format: ${proxyString}`);
    }

    return {
      protocol: match[1],
      username: match[2],
      password: match[3],
      host: match[4],
      port: parseInt(match[5])
    };
  }

  initializeSession() {
    // Set up request interceptor for rate limiting and headers
    this.session.interceptors.request.use(async (config) => {
      await this.enforceRateLimit();
      this.addHeaders(config);
      this.addProxy(config);

      if (this.options.debug) {
        this.options.logger.info(`Request: ${config.method?.toUpperCase()} ${config.url}`, {
          headers: this.sanitizeHeaders(config.headers),
          proxy: config.proxy ? `${config.proxy.host}:${config.proxy.port}` : 'none'
        });
      }

      return config;
    });

    // Response interceptor for logging
    this.session.interceptors.response.use(
      (response) => {
        if (this.options.debug) {
          this.options.logger.info(`Response: ${response.status} ${response.config.url}`, {
            status: response.status,
            size: response.data?.length || 0,
            duration: Date.now() - response.config.metadata?.startTime
          });
        }
        return response;
      },
      (error) => {
        if (this.options.debug) {
          this.options.logger.error(`Request failed: ${error.config?.url}`, {
            status: error.response?.status,
            message: error.message
          });
        }
        return Promise.reject(error);
      }
    );
  }

  async enforceRateLimit() {
    const minInterval = Math.floor(60000 / this.options.requestsPerMinute);
    const elapsed = Date.now() - this.lastRequestTime;

    // Calculate delay with large random component for stealth
    const baseDelay = Math.max(minInterval - elapsed, 0);
    const randomDelay = this.options.minDelay +
      Math.random() * (this.options.maxDelay - this.options.minDelay);

    const totalDelay = Math.max(baseDelay, randomDelay);

    if (totalDelay > 0) {
      if (this.options.debug) {
        this.options.logger.debug(`Enforcing stealth delay: ${Math.round(totalDelay)}ms`);
      }
      await setTimeout(totalDelay);
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  addHeaders(config) {
    const userAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];

    config.headers = {
      ...config.headers,
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };

    config.metadata = { startTime: Date.now() };
  }

  addProxy(config) {
    if (this.proxies.length > 0) {
      const proxy = this.proxies[this.currentProxyIndex];
      config.proxy = {
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        auth: proxy.username ? {
          username: proxy.username,
          password: proxy.password
        } : undefined
      };

      if (this.options.debug) {
        this.options.logger.debug(`Using proxy: ${proxy.host}:${proxy.port}`);
      }

      // Rotate to next proxy for better distribution
      this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
    }
  }

  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    // Remove sensitive headers from logs
    delete sanitized.cookie;
    delete sanitized.authorization;
    return sanitized;
  }

  async request(method, url, options = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        const config = {
          method,
          url,
          ...options
        };

        const response = await this.session.request(config);
        return response;

      } catch (error) {
        lastError = error;

        if (attempt < this.options.maxRetries && this.shouldRetry(error)) {
          const delay = this.retryDelays[attempt] + Math.random() * 1000; // Add jitter

          if (this.options.debug) {
            this.options.logger.warn(`Retry ${attempt + 1}/${this.options.maxRetries} for ${url} in ${delay}ms`, {
              status: error.response?.status,
              message: error.message
            });
          }

          await setTimeout(delay);

          // Rotate proxy on retry if available
          if (this.proxies.length > 0) {
            this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
          }

          continue;
        }

        break;
      }
    }

    throw lastError;
  }

  shouldRetry(error) {
    if (!error.response) return true; // Network error

    const status = error.response.status;
    return status >= 500 || status === 429 || status === 403 || status === 408;
  }

  async get(url, options = {}) {
    return this.request('GET', url, options);
  }

  async post(url, data, options = {}) {
    return this.request('POST', url, { ...options, data });
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      proxiesLoaded: this.proxies.length,
      currentProxy: this.proxies.length > 0 ?
        `${this.proxies[this.currentProxyIndex].host}:${this.proxies[this.currentProxyIndex].port}` : 'none'
    };
  }
}