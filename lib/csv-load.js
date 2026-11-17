'use strict';

const fs = require('fs');

const { parseRecords } = require('./csv');
const { namesFor } = require('./naming');

// The downloaded list has these two headers. Both spellings of the swatch
// column have been seen, so either is accepted.
const COLOUR_COLUMNS = ['Color Values', 'Color', 'Colour'];
const URL_COLUMNS = ['Salsify Swatch', 'Swatch', 'Url', 'URL'];

function pickColumn(headers, candidates, file) {
  const found = candidates.find((c) => headers.includes(c));
  if (!found) {
    throw new Error(
      `${file}: could not find a ${candidates[0]} column. Expected one of: ${candidates.join(', ')}. Found: ${headers.join(', ')}`
    );
  }
  return found;
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Returns { rows, skipped, collisions }.
//
// rows are usable colours in CSV order. skipped holds rows that cannot be
// processed, with a reason, so the run reports them instead of failing whole.
// collisions holds colours whose urlName matches another colour's - "Slate" and
// "SLATE" would both become swatch-slate and fight over one CMS record.
function loadColours(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { headers, records } = parseRecords(text);

  if (records.length === 0) throw new Error(`${file}: no data rows`);

  const colourCol = pickColumn(headers, COLOUR_COLUMNS, file);
  const urlCol = pickColumn(headers, URL_COLUMNS, file);

  const rows = [];
  const skipped = [];
  const byUrlName = new Map();
  const seenColour = new Map();

  for (const record of records) {
    const line = record.__line;
    const colour = String(record[colourCol] || '').trim();
    const sourceUrl = String(record[urlCol] || '').trim();

    if (!colour) {
      skipped.push({ line, colour, sourceUrl, reason: 'EMPTY_COLOR' });
      continue;
    }
    if (!sourceUrl) {
      skipped.push({ line, colour, sourceUrl, reason: 'EMPTY_URL' });
      continue;
    }
    if (!isHttpUrl(sourceUrl)) {
      skipped.push({ line, colour, sourceUrl, reason: 'BAD_URL' });
      continue;
    }

    // Color__c is unique case-insensitive in the org, so two rows differing
    // only by case would fail the CMDT deploy. Catch it here with a clear
    // reason instead of at deploy time with a platform error.
    const key = colour.toLowerCase();
    if (seenColour.has(key)) {
      skipped.push({ line, colour, sourceUrl, reason: 'DUPLICATE_COLOR', detail: `same colour as line ${seenColour.get(key)}` });
      continue;
    }
    seenColour.set(key, line);

    const names = namesFor(colour);
    rows.push({ line, colour, sourceUrl, ...names });

    const existing = byUrlName.get(names.urlName);
    if (existing) existing.push(colour);
    else byUrlName.set(names.urlName, [colour]);
  }

  const collisions = [...byUrlName.entries()]
    .filter(([, colours]) => colours.length > 1)
    .map(([urlName, colours]) => ({ urlName, colours }));

  return { rows, skipped, collisions, colourColumn: colourCol, urlColumn: urlCol };
}

// Colours sharing one source image are expected in this list - spelling
// variants such as "Clay Cannyon" and "Clay Canyon" point at the same Salsify
// asset. Each still gets its own CMS record so that every colour value a
// shopper might see resolves, but the download is shared.
function groupBySourceUrl(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.sourceUrl)) groups.set(row.sourceUrl, []);
    groups.get(row.sourceUrl).push(row);
  }
  return groups;
}

module.exports = { loadColours, groupBySourceUrl, COLOUR_COLUMNS, URL_COLUMNS };
