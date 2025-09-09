cat > lib/audit-logger.js << 'EOF'
import fs from 'fs-extra';
import path from 'path';
import pino from 'pino';

export class AuditLogger {
  constructor(auditDir) {
    this.auditDir = auditDir;
    this.snapshotsDir = path.join(auditDir, 'snapshots');
    this.htmlDir = path.join(auditDir, 'html');
    this.logsDir = path.join(auditDir, 'logs');
    
    this.logger = pino({
      level: 'info',
      transport: {
        target: 'pino/file',
        options: {
          destination: path.join(this.logsDir, 'audit.log'),
          mkdir: true
        }
      }
    });
  }

  async initialize() {
    await fs.ensureDir(this.snapshotsDir);
    await fs.ensureDir(this.htmlDir);
    await fs.ensureDir(this.logsDir);
    
    const sessionInfo = {
      startTime: new Date().toISOString(),
      pid: process.pid,
      nodeVersion: process.version
    };
    
    await fs.writeJson(
      path.join(this.logsDir, `session_${Date.now()}.json`),
      sessionInfo,
      { spaces: 2 }
    );
  }

  sanitizeFilename(name) {
    return name
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 100);
  }

  async logSnapshot(identifier, data) {
    try {
      const filename = `${this.sanitizeFilename(identifier)}_${Date.now()}.json`;
      const filepath = path.join(this.snapshotsDir, filename);
      
      const snapshot = {
        identifier: identifier,
        timestamp: new Date().toISOString(),
        data: data
      };
      
      await fs.writeJson(filepath, snapshot, { spaces: 2 });
      
      this.logger.info({
        msg: 'Snapshot saved',
        identifier: identifier,
        filename: filename
      });
      
    } catch (error) {
      this.logger.error({
        msg: 'Failed to save snapshot',
        identifier: identifier,
        error: error.message
      });
    }
  }

  async saveHTML(identifier, html) {
    try {
      const filename = `${this.sanitizeFilename(identifier)}_${Date.now()}.html`;
      const filepath = path.join(this.htmlDir, filename);
      
      await fs.writeFile(filepath, html, 'utf-8');
      
      this.logger.info({
        msg: 'HTML saved',
        identifier: identifier,
        filename: filename
      });
      
    } catch (error) {
      this.logger.error({
        msg: 'Failed to save HTML',
        identifier: identifier,
        error: error.message
      });
    }
  }

  async logMatch(searchName, matchedName, score, method) {
    this.logger.info({
      msg: 'Match found',
      search: searchName,
      matched: matchedName,
      score: score,
      method: method
    });
  }

  async logUnmatched(searchName, reason, candidates = []) {
    this.logger.warn({
      msg: 'No match found',
      search: searchName,
      reason: reason,
      candidateCount: candidates.length,
      topCandidates: candidates.slice(0, 3).map(c => ({
        name: c.name,
        score: c.match_score
      }))
    });
  }

  async logError(context, error) {
    this.logger.error({
      msg: 'Processing error',
      context: context,
      error: error.message,
      stack: error.stack
    });
  }

  async generateReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      snapshots: [],
      htmlFiles: [],
      errors: []
    };
    
    const snapshotFiles = await fs.readdir(this.snapshotsDir).catch(() => []);
    report.snapshots = snapshotFiles.filter(f => f.endsWith('.json'));
    
    const htmlFiles = await fs.readdir(this.htmlDir).catch(() => []);
    report.htmlFiles = htmlFiles.filter(f => f.endsWith('.html'));
    
    const logFile = path.join(this.logsDir, 'audit.log');
    if (await fs.pathExists(logFile)) {
      const logContent = await fs.readFile(logFile, 'utf-8');
      const lines = logContent.split('\n');
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.level >= 50) {
            report.errors.push({
              time: entry.time,
              msg: entry.msg,
              context: entry.context
            });
          }
        } catch (e) {
          // Skip malformed lines
        }
      }
    }
    
    const reportPath = path.join(this.auditDir, 'audit_report.json');
    await fs.writeJson(reportPath, report, { spaces: 2 });
    
    return report;
  }

  async cleanup(daysToKeep = 30) {
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    
    const directories = [this.snapshotsDir, this.htmlDir];
    let deletedCount = 0;
    
    for (const dir of directories) {
      const files = await fs.readdir(dir).catch(() => []);
      
      for (const file of files) {
        const filepath = path.join(dir, file);
        const stats = await fs.stat(filepath).catch(() => null);
        
        if (stats && stats.mtimeMs < cutoffTime) {
          await fs.remove(filepath);
          deletedCount++;
        }
      }
    }
    
    this.logger.info({
      msg: 'Cleanup completed',
      deletedFiles: deletedCount,
      daysKept: daysToKeep
    });
    
    return deletedCount;
  }
}
EOF