'use strict';

// A small RFC 4180 reader and writer, so this tool installs with no
// dependencies at all. The sibling CMS projects use csv-parse, but a two-column
// input and a flat report do not justify an npm install step on a Windows
// machine where `npm` may not be on PATH.
//
// Handles: quoted fields, embedded commas, escaped quotes (""), CRLF or LF
// line endings, and a UTF-8 BOM - Excel writes one when you "Save As CSV",
// and an unstripped BOM turns the first header into "﻿Color Values",
// which silently reads as a missing column.

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Returns the parsed rows. When `withLines` is set each row carries a
// non-enumerable `line` holding the 1-based line in the source file it started
// on. Blank lines are dropped, so a row's index in this array is NOT its line
// number - deriving one from the other reports errors against the wrong row of
// the operator's spreadsheet.
function parse(text, { withLines = false } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;
  let line = 1;
  let rowStartLine = 1;

  const source = stripBom(String(text));

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A trailing newline at end of file must not produce a phantom row, and
    // blank lines inside the file are skipped rather than yielding [''].
    if (!(row.length === 1 && row[0] === '')) {
      if (withLines) Object.defineProperty(row, 'line', { value: rowStartLine, enumerable: false });
      rows.push(row);
    }
    row = [];
    rowStartLine = line;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    sawAnyChar = true;

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      // Swallow the LF of a CRLF pair; a lone CR still ends the row.
      if (source[i + 1] === '\n') i++;
      line++;
      endRow();
    } else if (ch === '\n') {
      line++;
      endRow();
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0 || !sawAnyChar) endRow();

  return rows;
}

// Returns { headers, records } where each record is a plain object keyed by
// header. Duplicate headers would silently shadow each other, so they fail.
function parseRecords(text) {
  const rows = parse(text, { withLines: true });
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  const seen = new Set();
  for (const h of headers) {
    if (seen.has(h)) throw new Error(`Duplicate column "${h}" in header row`);
    seen.add(h);
  }

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const record = {};
    for (let c = 0; c < headers.length; c++) record[headers[c]] = cells[c] ?? '';
    // The real source line, not the row index: blank lines would otherwise
    // make every later row report a number short of where it actually is.
    record.__line = cells.line ?? i + 1;
    records.push(record);
  }

  return { headers, records };
}

function quote(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CRLF because these reports are opened in Excel on Windows.
function stringify(columns, records) {
  const lines = [columns.map(quote).join(',')];
  for (const record of records) {
    lines.push(columns.map((c) => quote(record[c])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { parse, parseRecords, stringify, stripBom };
