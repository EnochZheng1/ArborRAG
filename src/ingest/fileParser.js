import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import * as cheerio from "cheerio";

// Point pdfjs at its worker and CMap directory
const _dir = path.dirname(fileURLToPath(import.meta.url));
const _root = path.resolve(_dir, "../../");
GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(_root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
).href;
const CMAP_URL = path.join(_root, "node_modules/pdfjs-dist/cmaps/") + "/";

// Magic byte signatures for binary file types
const MAGIC_BYTES = {
  '.pdf': [0x25, 0x50, 0x44, 0x46],  // %PDF
  '.docx': [0x50, 0x4B, 0x03, 0x04], // PK (ZIP archive)
  '.xlsx': [0x50, 0x4B, 0x03, 0x04], // PK (ZIP archive)
  '.pptx': [0x50, 0x4B, 0x03, 0x04], // PK (ZIP archive)
  '.xls': [0xD0, 0xCF, 0x11, 0xE0],  // OLE2 compound document
};

function validateFileType(filePath, ext) {
  const expected = MAGIC_BYTES[ext];
  if (!expected) return true; // No magic bytes check for .txt, .md, etc.
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(expected.length);
    fs.readSync(fd, buf, 0, expected.length, 0);
    fs.closeSync(fd);
    return expected.every((byte, i) => buf[i] === byte);
  } catch {
    return false; // Can't read = reject
  }
}

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
  ".csv": "csv",
  ".pptx": "pptx"
};

/**
 * Parse a file and extract text content + document metadata.
 * @param {string} filePath - Path to the file
 * @returns {Promise<{content: string, metadata: object}>}
 */
export async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileType = SUPPORTED_TYPES[ext];

  if (!fileType) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  if (!validateFileType(filePath, ext)) {
    throw new Error(`File content does not match expected ${ext} format`);
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
  let docMeta = null;  // document-level metadata (author, title, dates)

  switch (fileType) {
    case "text":
    case "markdown":
      content = await parseTextFile(filePath);
      break;
    case "pdf":
      ({ content, docMeta } = await parsePdfFile(filePath));
      break;
    case "docx":
    case "doc":
      ({ content, docMeta } = await parseDocxFile(filePath));
      break;
    case "pptx":
      ({ content, docMeta } = await parsePptxFile(filePath));
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

  // Merge document-level metadata (author, title, dates) into file metadata
  if (docMeta) {
    metadata.document = docMeta;
  }

  return { content, metadata };
}

// Plain text and markdown
async function parseTextFile(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

// PDF files — uses pdfjs-dist for proper CJK and ligature support
async function parsePdfFile(filePath) {
  const data = fs.readFileSync(filePath);
  const pdf = await getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    verbosity: 0,
  }).promise;

  // Extract document-level metadata (author, title, dates, etc.)
  let docMeta = null;
  try {
    const meta = await pdf.getMetadata();
    const info = meta?.info;
    if (info) {
      docMeta = {};
      if (info.Title)        docMeta.title = String(info.Title).trim();
      if (info.Author)       docMeta.author = String(info.Author).trim();
      if (info.Subject)      docMeta.subject = String(info.Subject).trim();
      if (info.Creator)      docMeta.creator = String(info.Creator).trim();
      if (info.Producer)     docMeta.producer = String(info.Producer).trim();
      if (info.CreationDate) docMeta.createdAt = parsePdfDate(String(info.CreationDate));
      if (info.ModDate)      docMeta.modifiedAt = parsePdfDate(String(info.ModDate));
      // Only keep docMeta if it has any useful fields
      if (Object.keys(docMeta).length === 0) docMeta = null;
    }
  } catch (_) { /* metadata extraction is best-effort */ }

  const pageTexts = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent({ includeMarkedContent: false });

    // Reconstruct lines by grouping items with the same Y coordinate.
    // Items are emitted top-to-bottom by pdfjs, so we compare rounded Y values.
    const lines = [];
    let lastY = null;
    let lineItems = [];

    for (const item of content.items) {
      const str = item.str;
      if (!str) continue;
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (lineItems.length) lines.push(lineItems.join(""));
        lineItems = [];
      }
      lineItems.push(str);
      lastY = y;
    }
    if (lineItems.length) lines.push(lineItems.join(""));

    const pageText = lines.join("\n").trim();
    if (pageText) pageTexts.push(pageText);
  }

  docMeta = docMeta || {};
  docMeta.pageCount = pdf.numPages;

  await pdf.destroy();
  return { content: pageTexts.join("\n\n"), docMeta };
}

/**
 * Parse PDF date format (D:YYYYMMDDHHmmSS) to ISO string.
 * Returns the original string if parsing fails.
 */
function parsePdfDate(dateStr) {
  if (!dateStr) return null;
  // PDF dates: D:20240115120000+05'30' or D:20240115
  const m = dateStr.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return dateStr;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  try { return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).toISOString(); }
  catch (_) { return dateStr; }
}

// Word documents (docx)
async function parseDocxFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });

  // Extract document metadata from docProps/core.xml inside the DOCX zip
  let docMeta = null;
  try {
    docMeta = extractDocxMetadata(buffer);
  } catch (_) { /* metadata extraction is best-effort */ }

  return { content: result.value, docMeta };
}

/**
 * Extract metadata from DOCX (ZIP) by reading docProps/core.xml.
 * Uses the XLSX library's zip infrastructure (already a dependency).
 */
function extractDocxMetadata(buffer) {
  const zip = XLSX.read(buffer, { type: "buffer", bookSheets: true });
  // XLSX exposes the raw zip entries via zip.files when used with type:"buffer"
  // But the simpler approach: parse the buffer as a zip manually using the
  // lightweight approach of looking for the core.xml within the DOCX.

  // Alternative: use cheerio to parse the XML if we can get it.
  // DOCX is a ZIP, and we already have the XLSX library which can read ZIPs.
  // However XLSX.read for DOCX may not expose internal files easily.
  // Let's try a direct approach: read the zip entries.

  // Since XLSX may not expose docProps, use a lightweight manual extraction.
  // The core.xml is typically small and located at a known offset in the ZIP.
  const content = buffer.toString('utf-8');
  const meta = {};

  // Look for common metadata patterns in the raw XML within the ZIP
  const creatorMatch = content.match(/<dc:creator>([^<]+)<\/dc:creator>/);
  if (creatorMatch) meta.author = creatorMatch[1].trim();

  const titleMatch = content.match(/<dc:title>([^<]+)<\/dc:title>/);
  if (titleMatch) meta.title = titleMatch[1].trim();

  const subjectMatch = content.match(/<dc:subject>([^<]+)<\/dc:subject>/);
  if (subjectMatch) meta.subject = subjectMatch[1].trim();

  const descMatch = content.match(/<dc:description>([^<]+)<\/dc:description>/);
  if (descMatch) meta.description = descMatch[1].trim();

  const createdMatch = content.match(/<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/);
  if (createdMatch) meta.createdAt = createdMatch[1].trim();

  const modifiedMatch = content.match(/<dcterms:modified[^>]*>([^<]+)<\/dcterms:modified>/);
  if (modifiedMatch) meta.modifiedAt = modifiedMatch[1].trim();

  const revisionMatch = content.match(/<cp:revision>([^<]+)<\/cp:revision>/);
  if (revisionMatch) meta.revision = revisionMatch[1].trim();

  return Object.keys(meta).length > 0 ? meta : null;
}

// PowerPoint files (pptx)
async function parsePptxFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const content = buffer.toString('utf-8');

  // PPTX is a ZIP containing ppt/slides/slide*.xml with <a:t> text elements
  const slides = [];
  const allTextRuns = [...content.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g)];

  // Find slide file positions in the ZIP
  const slidePositions = [...content.matchAll(/ppt\/slides\/slide(\d+)\.xml/g)]
    .map(m => ({ num: parseInt(m[1], 10), pos: m.index }))
    .sort((a, b) => a.pos - b.pos);

  if (allTextRuns.length > 0 && slidePositions.length > 0) {
    for (let i = 0; i < slidePositions.length; i++) {
      const start = slidePositions[i].pos;
      const end = i + 1 < slidePositions.length ? slidePositions[i + 1].pos : content.length;
      const slideContent = content.slice(start, end);
      const texts = [...slideContent.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g)]
        .map(m => m[1].trim())
        .filter(t => t.length > 0);
      if (texts.length > 0) {
        slides.push(`[Slide ${slidePositions[i].num}]\n${texts.join('\n')}`);
      }
    }
  } else if (allTextRuns.length > 0) {
    // No slide markers found, just collect all text
    const texts = allTextRuns.map(m => m[1].trim()).filter(t => t.length > 0);
    slides.push(texts.join('\n'));
  }

  // Extract speaker notes from notesSlides
  const notePositions = [...content.matchAll(/ppt\/notesSlides\/notesSlide(\d+)\.xml/g)]
    .map(m => ({ num: parseInt(m[1], 10), pos: m.index }))
    .sort((a, b) => a.pos - b.pos);

  if (notePositions.length > 0) {
    const noteTexts = [];
    for (let i = 0; i < notePositions.length; i++) {
      const start = notePositions[i].pos;
      const end = i + 1 < notePositions.length ? notePositions[i + 1].pos : content.length;
      const noteContent = content.slice(start, end);
      const texts = [...noteContent.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g)]
        .map(m => m[1].trim())
        .filter(t => t.length > 0 && !/^\d+$/.test(t)); // skip slide number placeholders
      if (texts.length > 0) {
        noteTexts.push(`[Notes - Slide ${notePositions[i].num}]\n${texts.join('\n')}`);
      }
    }
    if (noteTexts.length > 0) {
      slides.push('\n---\nSpeaker Notes\n' + noteTexts.join('\n\n'));
    }
  }

  // Extract metadata (same docProps/core.xml structure as DOCX)
  let docMeta = null;
  try {
    docMeta = extractDocxMetadata(buffer);
    if (docMeta) docMeta.slideCount = slidePositions.length;
  } catch (_) { /* best-effort */ }

  return { content: slides.join('\n\n') || '(No text content found in presentation)', docMeta };
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
