import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function cleanupOrphanedUploads() {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    const now = Date.now();
    let cleaned = 0;
    for (const file of fs.readdirSync(UPLOADS_DIR)) {
      const filePath = path.join(UPLOADS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (_) {}
    }
    if (cleaned > 0) logger.info(`Cleaned ${cleaned} orphaned upload(s)`);
  } catch (err) {
    logger.warn(`Upload cleanup failed: ${err.message}`);
  }
}
