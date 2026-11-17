'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildRecordXml, buildPackageXml, escapeXml, stageDeployment, verify } = require('../lib/cmdt');

test('record xml carries both fields and is unprotected', () => {
  const xml = buildRecordXml({ label: 'Acorn', colour: 'Acorn', contentKey: 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.match(xml, /<label>Acorn<\/label>/);
  // Protected records are unreadable from Apex outside the defining
  // namespace, which would include the storefront's controller.
  assert.match(xml, /<protected>false<\/protected>/);
  assert.match(xml, /<field>Color__c<\/field>/);
  assert.match(xml, /<field>ContentKey__c<\/field>/);
  assert.match(xml, /MCAAAAAAAAAAAAAAAAAAAAAAAAAA/);
});

test('escapes xml metacharacters in a colour name', () => {
  const xml = buildRecordXml({ label: 'White & Almond', colour: 'White & Almond', contentKey: 'MCABC' });
  assert.match(xml, /White &amp; Almond/);
  assert.ok(!/White & Almond/.test(xml));
  assert.equal(escapeXml('<a>"\'</a>'), '&lt;a&gt;&quot;&apos;&lt;/a&gt;');
});

test('package xml lists every member under CustomMetadata', () => {
  const xml = buildPackageXml(['ECOM_Color_Swatch.Swatch_Acorn', 'ECOM_Color_Swatch.Swatch_Pine']);
  assert.match(xml, /<members>ECOM_Color_Swatch.Swatch_Acorn<\/members>/);
  assert.match(xml, /<members>ECOM_Color_Swatch.Swatch_Pine<\/members>/);
  assert.match(xml, /<name>CustomMetadata<\/name>/);
});

test('staging writes one file per record plus a project and package manifest', () => {
  const staged = stageDeployment([
    { devName: 'Swatch_Acorn', label: 'Acorn', colour: 'Acorn', contentKey: 'MCA' },
    { devName: 'Swatch_Pine', label: 'Pine', colour: 'Pine', contentKey: 'MCB' },
  ]);
  try {
    assert.ok(fs.existsSync(path.join(staged.root, 'sfdx-project.json')));
    assert.ok(fs.existsSync(path.join(staged.sourceDir, 'package.xml')));
    assert.ok(fs.existsSync(path.join(staged.sourceDir, 'ECOM_Color_Swatch.Swatch_Acorn.md-meta.xml')));
    assert.deepEqual(staged.fullNames, ['ECOM_Color_Swatch.Swatch_Acorn', 'ECOM_Color_Swatch.Swatch_Pine']);
  } finally {
    staged.cleanup();
  }
  assert.ok(!fs.existsSync(staged.root), 'cleanup should remove the staged directory');
});

test('verification reports a missing row and a wrong key separately', async () => {
  const records = [
    { devName: 'Swatch_Acorn', colour: 'Acorn', contentKey: 'MCA' },
    { devName: 'Swatch_Pine', colour: 'Pine', contentKey: 'MCB' },
    { devName: 'Swatch_Slate', colour: 'Slate', contentKey: 'MCC' },
  ];
  const fakeRead = async () => new Map([
    ['acorn', { colour: 'Acorn', contentKey: 'MCA' }],
    ['pine', { colour: 'Pine', contentKey: 'WRONG' }],
  ]);

  const result = await verify(null, records, fakeRead, { attempts: 1 });
  assert.equal(result.verified, 1);
  assert.deepEqual(result.missing.map((m) => m.colour), ['Slate']);
  assert.deepEqual(result.mismatched.map((m) => m.colour), ['Pine']);
  assert.equal(result.mismatched[0].actualContentKey, 'WRONG');
});

test('verification matches colours case-insensitively', async () => {
  // Color__c is unique case-insensitive, so a row stored as "SLATE" must
  // satisfy a record written as "Slate" rather than read as missing.
  const fakeRead = async () => new Map([['slate', { colour: 'SLATE', contentKey: 'MCC' }]]);
  const result = await verify(null, [{ devName: 'Swatch_Slate', colour: 'Slate', contentKey: 'MCC' }], fakeRead, { attempts: 1 });
  assert.equal(result.verified, 1);
});

// The readback exists because custom metadata has been seen to deploy
// successfully and not be queryable for a few seconds. Checking once would
// report every record NOT_READABLE and exit non-zero on a good deploy.
test('readback waits for rows that land late', async () => {
  let call = 0;
  const lateRead = async () => {
    call++;
    return call < 3 ? new Map() : new Map([['acorn', { colour: 'Acorn', contentKey: 'MCA' }]]);
  };

  const result = await verify(null, [{ devName: 'Swatch_Acorn', colour: 'Acorn', contentKey: 'MCA' }], lateRead, { attempts: 5, delayMs: 1 });
  assert.equal(result.verified, 1);
  assert.equal(result.missing.length, 0);
  assert.equal(call, 3);
});

test('a row that never appears is reported missing after the last attempt', async () => {
  const emptyRead = async () => new Map();
  const result = await verify(null, [{ devName: 'Swatch_Pine', colour: 'Pine', contentKey: 'MCB' }], emptyRead, { attempts: 3, delayMs: 1 });
  assert.equal(result.verified, 0);
  assert.deepEqual(result.missing.map((m) => m.colour), ['Pine']);
});

// Regression: an early mismatch used to be wiped by the next retry pass, so
// the record was counted as verified and the wrong key went unreported.
test('a mismatch found early survives later retry passes', async () => {
  let call = 0;
  const read = async () => {
    call++;
    const rows = new Map([['pine', { colour: 'Pine', contentKey: 'WRONG' }]]);
    if (call >= 3) rows.set('acorn', { colour: 'Acorn', contentKey: 'MCA' });
    return rows;
  };

  const records = [
    { devName: 'Swatch_Pine', colour: 'Pine', contentKey: 'MCB' },
    { devName: 'Swatch_Acorn', colour: 'Acorn', contentKey: 'MCA' },
  ];
  const result = await verify(null, records, read, { attempts: 5, delayMs: 1 });
  assert.equal(result.verified, 1);
  assert.deepEqual(result.mismatched.map((m) => m.colour), ['Pine']);
  assert.equal(result.missing.length, 0);
});

test('report notes accumulate rather than overwrite', () => {
  const { createReport } = require('../lib/report');
  const report = createReport('testorg', os.tmpdir());
  report.row({ color: 'Acorn', note: 'already published in this workspace', cmdtAction: 'pending' });
  report.update('Acorn', { cmdtAction: 'unchanged', note: 'delete not performed (HTTP 405)' });
  report.update('acorn', { note: 'and another' });

  // Written through the public surface: the row is reachable only by writing.
  const file = report.write()[0];
  const body = fs.readFileSync(file, 'utf8');
  fs.unlinkSync(file);
  assert.match(body, /already published in this workspace; delete not performed \(HTTP 405\); and another/);
  assert.match(body, /unchanged/);
});
