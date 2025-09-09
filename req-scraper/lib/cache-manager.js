import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

export class CacheManager {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.initializeDirectories();
  }

  async initializeDirectories() {
    await fs.ensureDir(path.join(this.cacheDir, 'req'));
    await fs.ensureDir(path.join(this.cacheDir, 'corp_can'));
    await fs.ensureDir(path.join(this.cacheDir, 'enriched'));
  }

  generateKey(query) {
    return crypto
      .createHash('md5')
      .update(query.toLowerCase())
      .digest('hex');
  }

  async get(type, query) {
    try {
      const key = this.generateKey(query);
      const filename = `${key}.json`;
      const filepath = path.join(this.cacheDir, type, filename);
      
      if (await fs.pathExists(filepath)) {
        const data = await fs.readJson(filepath);
        const cacheAge = Date.now() - (data.cachedAt || 0);
        const maxAge = 7 * 24 * 60 * 60 * 1000;
        
        if (cacheAge < maxAge) {
          return data.content;
        }
      }
      
      return null;
    } catch (error) {
      console.warn(`Cache read error for ${type}/${query}:`, error.message);
      return null;
    }
  }

  async set(type, query, content) {
    try {
      const key = this.generateKey(query);
      const filename = `${key}.json`;
      const filepath = path.join(this.cacheDir, type, filename);
      
      const cacheData = {
        query: query,
        content: content,
        cachedAt: Date.now()
      };
      
      await fs.writeJson(filepath, cacheData, { spaces: 2 });
      
      const indexPath = path.join(this.cacheDir, type, 'index.json');
      const index = await fs.readJson(indexPath).catch(() => ({}));
      index[key] = {
        query: query,
        cachedAt: new Date().toISOString(),
        filename: filename
      };
      await fs.writeJson(indexPath, index, { spaces: 2 });
      
    } catch (error) {
      console.warn(`Cache write error for ${type}/${query}:`, error.message);
    }
  }

  async clear(type = null) {
    if (type) {
      await fs.emptyDir(path.join(this.cacheDir, type));
    } else {
      await fs.emptyDir(this.cacheDir);
      await this.initializeDirectories();
    }
  }
}