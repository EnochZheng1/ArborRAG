import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import * as cheerio from "cheerio";

// Supported file types
const SUPPORTED_TYPES = {
  ".txt": "text",
  ".md": "markdown",
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "doc",
  ".xlsx": "xlsx",
  ".xls": "xls",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".csv": "csv"
};

/**
 * Parse a file and extract text content
 * @param {string} filePath - Path to the file
 * @returns {Promise<{content: string, metadata: object}>}
 */
export async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileType = SUPPORTED_TYPES[ext];

  if (!fileType) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const stats = fs.statSync(filePath);
  const metadata = {
    filename: path.basename(filePath),
    extension: ext,
    fileType,
    fileSize: stats.size,
    modifiedAt: stats.mtime.toISOString()
  };

  let content;

  switch (fileType) {
    case "text":
    case "markdown":
      content = await parseTextFile(filePath);
      break;
    case "pdf":
      content = await parsePdfFile(filePath);
      break;
    case "docx":
    case "doc":
      content = await parseDocxFile(filePath);
      break;
    case "xlsx":
    case "xls":
      content = await parseExcelFile(filePath);
      break;
    case "html":
      content = await parseHtmlFile(filePath);
      break;
    case "json":
      content = await parseJsonFile(filePath);
      break;
    case "csv":
      content = await parseCsvFile(filePath);
      break;
    default:
      throw new Error(`Parser not implemented for type: ${fileType}`);
  }

  return { content, metadata };
}

// Plain text and markdown
async function parseTextFile(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

// PDF files
async function parsePdfFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  return result.text;
}

// Word documents (docx)
async function parseDocxFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// Excel files
async function parseExcelFile(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    if (data.length > 0) {
      const text = data
        .map(row => row.join("\t"))
        .filter(line => line.trim())
        .join("\n");

      if (text) {
        sheets.push(`[Sheet: ${sheetName}]\n${text}`);
      }
    }
  }

  return sheets.join("\n\n---\n\n");
}

// HTML files
async function parseHtmlFile(filePath) {
  const html = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(html);

  // Remove script and style elements
  $("script, style, noscript").remove();

  // Get text content
  const text = $("body").text() || $.root().text();

  // Clean up whitespace
  return text
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

// JSON files (convert to readable text)
async function parseJsonFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);
  return formatJsonAsText(data);
}

// CSV files
async function parseCsvFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const workbook = XLSX.read(content, { type: "string" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  return data
    .map(row => row.join("\t"))
    .filter(line => line.trim())
    .join("\n");
}

// Helper to format JSON as readable text
function formatJsonAsText(obj, depth = 0) {
  const indent = "  ".repeat(depth);

  if (obj === null || obj === undefined) {
    return "";
  }

  if (typeof obj === "string") {
    return obj;
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return String(obj);
  }

  if (Array.isArray(obj)) {
    return obj
      .map((item, i) => `${indent}${i + 1}. ${formatJsonAsText(item, depth + 1)}`)
      .join("\n");
  }

  if (typeof obj === "object") {
    return Object.entries(obj)
      .map(([key, value]) => {
        const formattedValue = formatJsonAsText(value, depth + 1);
        if (formattedValue.includes("\n")) {
          return `${indent}${key}:\n${formattedValue}`;
        }
        return `${indent}${key}: ${formattedValue}`;
      })
      .join("\n");
  }

  return String(obj);
}

/**
 * Check if a file type is supported
 * @param {string} filename - Filename or path
 * @returns {boolean}
 */
export function isSupportedFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext in SUPPORTED_TYPES;
}

/**
 * Get file type from filename
 * @param {string} filename - Filename or path
 * @returns {string|null}
 */
export function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_TYPES[ext] || null;
}

/**
 * Get list of supported extensions
 * @returns {string[]}
 */
export function getSupportedExtensions() {
  return Object.keys(SUPPORTED_TYPES);
}
