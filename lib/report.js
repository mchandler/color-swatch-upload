'use strict';

const fs = require('fs');
const path = require('path');

const { stringify } = require('./csv');
const { writeFileAtomic } = require('./atomic-write');

const COLUMNS = [
  'line', 'color', 'sourceUrl', 'title', 'urlName', 'cmdtRecord',
  'contentKey', 'contentId', 'action', 'published', 'cmdtAction', 'bytes', 'note',
];

const ERROR_COLUMNS = ['line', 'color', 'sourceUrl', 'phase', 'errorCode', 'errorMessage'];

function timestampSlug(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// Both files are written at the end from memory rather than streamed: 81 rows
// is nothing, and it means an aborted run leaves no truncated report that
// looks complete.
function createReport(orgAlias, outDir = process.cwd()) {
  const slug = timestampSlug();
  const rows = [];
  const errors = [];
  const byColour = new Map();

  return {
    reportFile: path.resolve(outDir, `swatches-${orgAlias}-${slug}.csv`),
    errorFile: path.resolve(outDir, `errors-${orgAlias}-${slug}.csv`),
    // Returns nothing, but the row stays addressable by colour so a later
    // phase can record its outcome. Report rows are built during the upload
    // phase, and whether the metadata landed is not known until after it.
    row(record) {
      rows.push(record);
      if (record.color) byColour.set(String(record.color).toLowerCase(), record);
    },
    // Amends a row written earlier in the run, so the per-row report tells the
    // truth about the metadata step rather than leaving every row "pending".
    update(colour, fields) {
      const row = byColour.get(String(colour).toLowerCase());
      if (!row) return;
      const { note, ...rest } = fields;
      Object.assign(row, rest);
      // Notes accumulate. Replacing would drop the earlier one - the cleanup
      // step's note was overwriting "already published in this workspace".
      if (note) row.note = row.note ? `${row.note}; ${note}` : note;
    },
    error(record) {
      errors.push({
        line: record.line ?? '',
        color: record.colour ?? record.color ?? '',
        sourceUrl: record.sourceUrl ?? '',
        phase: record.phase ?? '',
        errorCode: record.errorCode ?? '',
        errorMessage: String(record.errorMessage ?? '').slice(0, 500),
      });
    },
    get errorCount() {
      return errors.length;
    },
    write() {
      const written = [];
      if (rows.length > 0) {
        writeFileAtomic(this.reportFile, stringify(COLUMNS, rows));
        written.push(this.reportFile);
      }
      // Only written when something failed, so a clean run leaves no empty
      // error file to worry someone later.
      if (errors.length > 0) {
        writeFileAtomic(this.errorFile, stringify(ERROR_COLUMNS, errors));
        written.push(this.errorFile);
      }
      return written;
    },
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { createReport, ensureDir, timestampSlug, COLUMNS, ERROR_COLUMNS };
