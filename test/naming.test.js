'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { namesFor, urlName, apiName, devName, DEV_NAME_MAX, CMS_NAME_MAX } = require('../lib/naming');

test('derives all four names from a simple colour', () => {
  const n = namesFor('Acorn');
  assert.equal(n.colour, 'Acorn');
  assert.equal(n.title, 'Swatch - Acorn');
  assert.equal(n.urlName, 'swatch-acorn');
  assert.equal(n.apiName, 'Swatch_Acorn');
  assert.equal(n.devName, 'Swatch_Acorn');
  assert.equal(n.altText, 'Acorn color swatch');
});

test('multi-word colours hyphenate the api name and underscore the record name', () => {
  const n = namesFor('Country Blue');
  assert.equal(n.title, 'Swatch - Country Blue');
  assert.equal(n.urlName, 'swatch-country-blue');
  assert.equal(n.devName, 'Swatch_Country_Blue');
});

test('trims surrounding whitespace from the csv value', () => {
  const n = namesFor('  Dark Bronze  ');
  assert.equal(n.colour, 'Dark Bronze');
  assert.equal(n.urlName, 'swatch-dark-bronze');
  assert.equal(n.devName, 'Swatch_Dark_Bronze');
});

test('upper case colours slugify to the same api name as mixed case', () => {
  // "Slate" and "SLATE GRAY" are different colours, but "SLATE" and "Slate"
  // are the same one spelled twice - the loader relies on this collapsing so
  // it can report the collision instead of creating two records.
  assert.equal(urlName('SLATE'), urlName('Slate'));
  assert.equal(urlName('SLATE GRAY'), 'swatch-slate-gray');
});

test('punctuation collapses to a single separator', () => {
  assert.equal(urlName('White/Almond'), 'swatch-white-almond');
  assert.equal(urlName('Terratone  (Dark)'), 'swatch-terratone-dark');
  assert.equal(devName('White/Almond'), 'Swatch_White_Almond');
});

test('record names never exceed the platform cap and stay unique', () => {
  const long = 'Extraordinarily Long Storm Door Forest Green Variant Name';
  const name = devName(long);
  assert.ok(name.length <= DEV_NAME_MAX, `${name} is ${name.length} chars`);
  assert.notEqual(name, devName(`${long} Two`));
});

test('record names never end with an underscore', () => {
  assert.ok(!devName('Sandtone ').endsWith('_'));
  assert.ok(!devName('Cocoa -').endsWith('_'));
});

test('a colour starting with a digit still yields a legal record name', () => {
  const name = devName('400 Series White');
  assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/);
});

test('the longest colour in the real list fits comfortably', () => {
  const name = devName('Storm Door Forest Green');
  assert.equal(name, 'Swatch_Storm_Door_Forest_Green');
  assert.ok(name.length <= DEV_NAME_MAX);
});

// The CMS API Name rules are stricter than the URL Name rules: only letters,
// digits and underscores, letter-initial, no doubled or trailing underscore,
// 80 characters. A hyphenated value is rejected outright, which would fail
// every create on the first real run while a dry run looked perfect.
test('api name never contains a hyphen', () => {
  for (const colour of ['Country Blue', 'White/Almond', 'SLATE GRAY', 'Terratone  (Dark)', '400 Series White']) {
    assert.ok(!apiName(colour).includes('-'), `${colour} -> ${apiName(colour)}`);
  }
});

test('api name is letter-initial, single-underscored and within 80 chars', () => {
  const colours = [
    'Acorn', 'Country Blue', '400 Series White', 'White/Almond',
    'Extraordinary Almond Storm Sandtone Clay Green Green Storm Deep',
    'x'.repeat(120),
  ];
  for (const colour of colours) {
    const name = apiName(colour);
    assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/, `${colour} -> ${name}`);
    assert.ok(!name.includes('__'), `${colour} -> ${name} has a doubled underscore`);
    assert.ok(!name.endsWith('_'), `${colour} -> ${name} ends with an underscore`);
    assert.ok(name.length <= CMS_NAME_MAX, `${colour} -> ${name} is ${name.length} chars`);
  }
});

// Truncation used to join the slice and the hash with an underscore without
// stripping a trailing one first, producing an illegal doubled underscore that
// the Metadata API rejects - failing the whole deploy, not just that record.
test('truncated record names never contain a doubled underscore', () => {
  const colours = [
    'Extraordinary Almond Storm Sandtone Clay Green Green Storm Deep',
    'Storm Door Forest Green Extra Long Marketing Colour Name Here',
    'A '.repeat(40),
  ];
  for (const colour of colours) {
    const name = devName(colour);
    assert.ok(!name.includes('__'), `${colour} -> ${name}`);
    assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/);
    assert.ok(name.length <= DEV_NAME_MAX);
  }
});

test('url names are capped at 80 characters and never end in a hyphen', () => {
  const long = `Extremely Long ${'Colour '.repeat(12)}Name`;
  const name = urlName(long);
  assert.ok(name.length <= CMS_NAME_MAX, `${name} is ${name.length} chars`);
  assert.ok(!name.endsWith('-'));
  assert.ok(name.startsWith('swatch-'));
});

test('two long colours that share a truncated prefix stay distinct', () => {
  const a = `${'Sandtone Clay Canyon Terratone Forest Green '}One`;
  const b = `${'Sandtone Clay Canyon Terratone Forest Green '}Two`;
  assert.notEqual(urlName(a), urlName(b));
  assert.notEqual(apiName(a), apiName(b));
  assert.notEqual(devName(a), devName(b));
});

// A punctuation-only value would otherwise collapse to the bare prefix, so
// every such colour would share one name and end in a separator.
test('a colour with no letters or digits still yields legal distinct names', () => {
  for (const colour of ['###', '---', '   -   ']) {
    assert.ok(!urlName(colour).endsWith('-'), `${colour} -> ${urlName(colour)}`);
    assert.notEqual(urlName(colour), 'swatch-');
    assert.match(apiName(colour), /^[A-Za-z][A-Za-z0-9_]*$/);
    assert.notEqual(devName(colour), 'Swatch');
  }
  assert.notEqual(urlName('###'), urlName('---'));
  assert.notEqual(devName('###'), devName('---'));
});
