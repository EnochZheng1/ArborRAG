/**
 * Simple Console Logger with levels and formatting.
 *
 * All WARN and ERROR messages are also written to a daily log file under
 * <project-root>/logs/error-YYYY-MM-DD.log so problems can be reviewed later.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── File logging setup ────────────────────────────────────────────────────────

const LOGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../logs');

try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (_) { /* non-fatal */ }

/** Strip ANSI escape codes so file output is plain text. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Append a plain-text line to a log file. Never throws.
 * @param {string} filePath  - absolute path to the log file
 */
function appendToFile(filePath, level, context, message, data) {
  try {
    const ctx  = context ? `[${context}] ` : '';
    let line   = `${timestamp()} ${level.padEnd(5)} ${ctx}${message}`;

    if (data !== undefined) {
      if (data instanceof Error) {
        line += `\n  ${data.stack || data.message}`;
      } else if (typeof data === 'object') {
        line += '\n' + JSON.stringify(data, null, 2);
      } else {
        line += ` ${stripAnsi(String(data))}`;
      }
    }

    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch (_) { /* never let file I/O break the application */ }
}

/**
 * Route log entries to the correct files:
 *  - INFO/WARN/ERROR → activity-YYYY-MM-DD.log  (full audit trail)
 *  - WARN/ERROR      → error-YYYY-MM-DD.log      (errors-only view)
 */
function writeToFile(level, context, message, data) {
  const date = new Date().toISOString().slice(0, 10);
  appendToFile(path.join(LOGS_DIR, `activity-${date}.log`), level, context, message, data);
  if (level === 'WARN' || level === 'ERROR') {
    appendToFile(path.join(LOGS_DIR, `error-${date}.log`), level, context, message, data);
  }
}

// ── Log levels ────────────────────────────────────────────────────────────────

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Get log level from environment (default: INFO)
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function formatMessage(level, context, message, data) {
  const ts = `${colors.dim}${timestamp()}${colors.reset}`;
  const ctx = context ? `${colors.cyan}[${context}]${colors.reset}` : '';

  let levelColor;
  switch (level) {
    case 'DEBUG': levelColor = colors.dim; break;
    case 'INFO': levelColor = colors.green; break;
    case 'WARN': levelColor = colors.yellow; break;
    case 'ERROR': levelColor = colors.red; break;
    default: levelColor = colors.reset;
  }

  const lvl = `${levelColor}${level.padEnd(5)}${colors.reset}`;

  let output = `${ts} ${lvl} ${ctx} ${message}`;

  if (data !== undefined) {
    if (typeof data === 'object') {
      output += '\n' + JSON.stringify(data, null, 2);
    } else {
      output += ` ${colors.dim}${data}${colors.reset}`;
    }
  }

  return output;
}

class Logger {
  constructor(context = '') {
    this.context = context;
  }

  debug(message, data) {
    if (currentLevel <= LOG_LEVELS.DEBUG) {
      console.log(formatMessage('DEBUG', this.context, message, data));
    }
  }

  info(message, data) {
    if (currentLevel <= LOG_LEVELS.INFO) {
      console.log(formatMessage('INFO', this.context, message, data));
    }
    writeToFile('INFO', this.context, message, data);
  }

  warn(message, data) {
    if (currentLevel <= LOG_LEVELS.WARN) {
      console.warn(formatMessage('WARN', this.context, message, data));
    }
    writeToFile('WARN', this.context, message, data);
  }

  error(message, data) {
    if (currentLevel <= LOG_LEVELS.ERROR) {
      console.error(formatMessage('ERROR', this.context, message, data));
    }
    writeToFile('ERROR', this.context, message, data);
  }

  // Create a child logger with sub-context
  child(subContext) {
    return new Logger(this.context ? `${this.context}:${subContext}` : subContext);
  }
}

// Create loggers for different modules
export const logger = new Logger();
export const dbLogger = new Logger('DB');
export const apiLogger = new Logger('API');
export const embedLogger = new Logger('EMBED');
export const queryLogger = new Logger('QUERY');
export const ingestLogger = new Logger('INGEST');

// Request logger middleware
export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const statusColor = status >= 400 ? colors.red : status >= 300 ? colors.yellow : colors.green;

    apiLogger.info(
      `${req.method} ${req.path} ${statusColor}${status}${colors.reset} ${colors.dim}${duration}ms${colors.reset}`
    );
  });

  next();
}

export default Logger;
