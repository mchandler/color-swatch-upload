'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parse, parseRecords, stringify } = require('../lib/csv');
const { loadColours, groupBySourceUrl } = require('../lib/csv-load');

test('parses quoted fields with embedded commas', () => {
  const rows = parse('a,"b,c",d\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b,c', 'd'], ['1', '2', '3']]);
});

test('parses escaped quotes', () => {
  assert.deepEqual(parse('"say ""hi""",x\n'), [['say "hi"', 'x']]);
});

test('handles crlf line endings', () => {
  assert.deepEqual(parse('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('strips a utf-8 bom from the first header', () => {
  // Excel writes a BOM on "Save As CSV"; left in place it turns the first
  // header into "﻿Color Values" and the column reads as missing.
  const { headers } = parseRecords('﻿Color Values,Salsify Swatch\nAcorn,https://x/y\n');
  assert.equal(headers[0], 'Color Values');
});

test('a trailing newline does not produce a phantom row', () => {
  assert.equal(parse('a\n1\n').length, 2);
});

test('rejects duplicate headers rather than shadowing one', () => {
  assert.throws(() => parseRecords('a,a\n1,2\n'), /Duplicate column/);
});

test('round-trips through stringify', () => {
  const csv = stringify(['x', 'y'], [{ x: 'has,comma', y: 'has "quote"' }]);
  const rows = parse(csv);
  assert.deepEqual(rows[1], ['has,comma', 'has "quote"']);
});

function writeTempCsv(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swatch-csv-'));
  const file = path.join(dir, 'colours.csv');
  fs.writeFileSync(file, body);
  return file;
}

test('loads colours and derives names', () => {
  const file = writeTempCsv('Color Values,Salsify Swatch\nAcorn,https://images.example.com/a\nCountry Blue,https://images.example.com/b\n');
  const { rows, skipped, collisions } = loadColours(file);
  assert.equal(rows.length, 2);
  assert.equal(skipped.length, 0);
  assert.equal(collisions.length, 0);
  assert.equal(rows[1].urlName, 'swatch-country-blue');
  assert.equal(rows[1].devName, 'Swatch_Country_Blue');
});

test('skips rows missing a colour or url, and non-http urls', () => {
  const file = writeTempCsv(
    'Color Values,Salsify Swatch\n' +
    ',https://images.example.com/a\n' +
    'Almond,\n' +
    'Pine,ftp://images.example.com/c\n' +
    'Acorn,https://images.example.com/d\n'
  );
  const { rows, skipped } = loadColours(file);
  assert.equal(rows.length, 1);
  assert.deepEqual(skipped.map((s) => s.reason), ['EMPTY_COLOR', 'EMPTY_URL', 'BAD_URL']);
});

test('reports a case-only duplicate colour instead of failing the deploy later', () => {
  // Color__c is unique case-insensitive in the org, so this would be rejected
  // at deploy time with a platform error if it got that far.
  const file = writeTempCsv('Color Values,Salsify Swatch\nSlate,https://images.example.com/a\nSLATE,https://images.example.com/b\n');
  const { rows, skipped } = loadColours(file);
  assert.equal(rows.length, 1);
  assert.equal(skipped[0].reason, 'DUPLICATE_COLOR');
});

test('accepts alternative header spellings', () => {
  const file = writeTempCsv('Color,Url\nAcorn,https://images.example.com/a\n');
  const { rows, colourColumn, urlColumn } = loadColours(file);
  assert.equal(rows.length, 1);
  assert.equal(colourColumn, 'Color');
  assert.equal(urlColumn, 'Url');
});

test('fails clearly when neither column is present', () => {
  const file = writeTempCsv('Shade,Picture\nAcorn,https://images.example.com/a\n');
  assert.throws(() => loadColours(file), /could not find a Color Values column/);
});

test('groups colours that share one source image', () => {
  const file = writeTempCsv(
    'Color Values,Salsify Swatch\n' +
    'Clay Canyon,https://images.example.com/shared\n' +
    'Clay Cannyon,https://images.example.com/shared\n' +
    'Acorn,https://images.example.com/a\n'
  );
  const { rows } = loadColours(file);
  const groups = groupBySourceUrl(rows);
  assert.equal(groups.size, 2);
  assert.equal(groups.get('https://images.example.com/shared').length, 2);
});

// Blank lines are dropped from the parsed rows, so deriving a line number from
// the row index reports errors against the wrong row of the spreadsheet.
test('reported line numbers survive blank lines', () => {
  const file = writeTempCsv(
    'Color Values,Salsify Swatch\n' +
    '\n' +
    'Acorn,https://images.example.com/a\n' +
    '\n' +
    'Pine,not-a-url\n'
  );
  const { rows, skipped } = loadColours(file);
  assert.equal(rows[0].line, 3);
  assert.equal(skipped[0].line, 5);
});

test('a quoted newline does not shift later line numbers', () => {
  const file = writeTempCsv(
    'Color Values,Salsify Swatch\n' +
    '"Acorn\nDeep",https://images.example.com/a\n' +
    'Pine,not-a-url\n'
  );
  const { skipped } = loadColours(file);
  assert.equal(skipped[0].line, 4);
});
