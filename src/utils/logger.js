/**
 * Simple Console Logger with levels and formatting
 */

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
  }

  warn(message, data) {
    if (currentLevel <= LOG_LEVELS.WARN) {
      console.warn(formatMessage('WARN', this.context, message, data));
    }
  }

  error(message, data) {
    if (currentLevel <= LOG_LEVELS.ERROR) {
      console.error(formatMessage('ERROR', this.context, message, data));
    }
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
