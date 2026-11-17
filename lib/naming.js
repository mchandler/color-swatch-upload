'use strict';

const crypto = require('crypto');

// Every name this tool writes derives from the colour as spelled in the CSV.
// Five names come out of one colour, and they are deliberately different
// shapes because three systems impose three different rulesets:
//
//   colour      "Country Blue"              exact CSV spelling, stored in Color__c
//   title       "Swatch - Country Blue"     what a CMS author sees
//   urlName     "swatch-country-blue"       CMS URL Name; lowercase, hyphens, 80 max
//   apiName     "Swatch_Country_Blue"       CMS API Name; [A-Za-z0-9_] only, 80 max
//   externalId  "swatch-country-blue"       our idempotency key in CMS
//   devName     "Swatch_Country_Blue"       CMDT record name; underscores, 40 max
//
// urlName and apiName are NOT interchangeable. Per the verified API record in
// ../sf-cms-url-to-binary/PROJECT.md 3.10, apiName accepts only letters,
// digits and underscores, must begin with a letter, and may not end in or
// double an underscore - a hyphenated value is rejected outright. That is why
// the sibling derives the two names separately and so does this.
//
// The urlName is what the admin-side reuse query matches on
// (UrlName LIKE 'swatch-%'), so the prefix is load-bearing: a bare colour name
// also matches product imagery such as "Acorn Aerosol Spray Paint".

const TITLE_PREFIX = 'Swatch - ';
const URL_PREFIX = 'swatch-';
const DEV_PREFIX = 'Swatch_';

// CMS caps urlName and apiName at 80; the platform caps CMDT record names at 40.
const CMS_NAME_MAX = 80;
const DEV_NAME_MAX = 40;
const SUFFIX_LEN = 5;

function title(colour) {
  return `${TITLE_PREFIX}${colour}`;
}

// Appends a short stable hash of the colour when truncation would otherwise
// make two long colours collide. The separator is stripped from the slice
// first, so the join can never produce a doubled separator - which is illegal
// in an apiName and in a CMDT record name.
function truncateWithHash(name, colour, max, separator) {
  if (name.length <= max) return name;
  const hash = crypto.createHash('sha256').update(String(colour)).digest('hex').slice(0, SUFFIX_LEN);
  const sliced = name.slice(0, max - SUFFIX_LEN - 1).replace(new RegExp(`\\${separator}+$`), '');
  return `${sliced}${separator}${hash}`;
}

// Lowercase, and every run of characters that is not a letter or digit becomes
// a single hyphen. "SLATE GRAY" and "Slate Gray" therefore collide by design -
// they are the same colour spelled two ways, and the loader reports collisions
// rather than silently merging them.
function urlName(colour) {
  const slug = String(colour)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A colour of pure punctuation would otherwise collapse to the bare prefix,
  // giving every such value the same name and a trailing separator.
  const body = slug || fallbackSlug(colour);
  return truncateWithHash(`${URL_PREFIX}${body}`, colour, CMS_NAME_MAX, '-');
}

// Only reached by a degenerate colour value. A hash keeps it unique and legal
// rather than letting two of them collide on the prefix.
function fallbackSlug(colour) {
  return crypto.createHash('sha256').update(String(colour)).digest('hex').slice(0, 8);
}

// The CMS API Name. Same prefix for recognisability, but underscore-separated
// to satisfy the character rule, and capped at 80 rather than 40.
function apiName(colour) {
  return buildUnderscoreName(colour, CMS_NAME_MAX);
}

// CMDT developer names follow the same character rules as apiName but are
// capped at 40, so both come from one builder with a different cap.
function devName(colour) {
  return buildUnderscoreName(colour, DEV_NAME_MAX);
}

function buildUnderscoreName(colour, max) {
  const core = String(colour)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  // Must begin with a letter, and the prefix guarantees that even when the
  // colour itself starts with a digit ("400 Series White").
  const name = `${DEV_PREFIX}${core || fallbackSlug(colour)}`;
  return truncateWithHash(name, colour, max, '_').replace(/_+$/g, '');
}

function externalId(colour) {
  // Deliberately the urlName form: it is already unique per colour, and
  // keeping them equal means one value identifies the content in both the
  // reuse query and the adoption lookup.
  return urlName(colour);
}

// CMS alt text. The CSV carries none, so it is generated; screen readers get
// something meaningful rather than a file name.
function altText(colour) {
  return `${colour} color swatch`;
}

// MasterLabel and Label are Text(40) on the CMDT, so a long colour is trimmed
// for the label even though Color__c (150) holds it in full.
function label(colour) {
  const s = String(colour);
  return s.length <= 40 ? s : s.slice(0, 40);
}

function fileName(colour, mimeType) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeType] || 'bin';
  return `${urlName(colour)}.${ext}`;
}

// One object per colour, so callers never re-derive a name and risk drift
// between the CMS record and the CMDT row that points at it.
function namesFor(colour) {
  const trimmed = String(colour).trim();
  return {
    colour: trimmed,
    title: title(trimmed),
    urlName: urlName(trimmed),
    apiName: apiName(trimmed),
    externalId: externalId(trimmed),
    devName: devName(trimmed),
    label: label(trimmed),
    altText: altText(trimmed),
  };
}

module.exports = {
  namesFor, title, urlName, apiName, externalId, devName, altText, label, fileName,
  TITLE_PREFIX, URL_PREFIX, DEV_PREFIX, DEV_NAME_MAX, CMS_NAME_MAX,
};
