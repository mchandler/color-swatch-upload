'use strict';

const fs = require('fs');
const path = require('path');

const { exitSync } = require('./exit');
const { ORG_ALIAS_RE } = require('./auth');

const USAGE = `Usage:
  node upload-swatches.js --workspace-id <id> --target-org <alias> --file <path> [options]

Uploads colour swatch images into a Salesforce CMS workspace and records each
one's ContentKey in the ECOM_Color_Swatch__mdt custom metadata type.

For every row in the CSV the tool downloads the source image, creates CMS image
content titled "Swatch - <Color>" with URL Name "swatch-<color>", publishes it,
and then deploys one custom metadata record per colour holding Color__c and
ContentKey__c. Colours whose swatch already exists in the workspace are reused
rather than uploaded again, and content left unpublished by an earlier run is
adopted and published rather than re-created.

Required:
  --workspace-id <id>        CMS workspace (content space) id, 0Zu...
  --target-org <alias>       Org alias as known to the sf CLI
  --file <path>              CSV with "Color Values" and "Salsify Swatch" columns

Options:
  --confirm-deploy           Required to write custom metadata. Without it the
                             CMS upload still runs and the CMDT step is skipped,
                             since writing custom metadata is a metadata deploy.
  --metadata-out <dir>       Write the custom metadata source to <dir> instead
                             of a temp directory, without deploying it. Use this
                             to get the records into version control and promote
                             them through a pipeline rather than deploying from
                             here. Works with or without --confirm-deploy, and
                             is honoured in --dry-run only if keys are known.
  --dry-run                  Download and report only. Uploads nothing, deploys
                             nothing, and leaves the org untouched.
  --folder <id>              Folder within the workspace for new content
  --cleanup-test-upload      Unpublish the legacy "Acorn (Test Swatch Upload)"
                             content once Swatch - Acorn exists and verifies
  --max-rows <n>             Process only the first n colours
  --cache-dir <path>         Download cache (default: .image-cache)
  --out-dir <path>           Where the report and error CSVs are written
                             (default: current directory)
  --pace <ms>                Delay between CMS writes (default: 300)
  --download-concurrency <n> Parallel source downloads (default: 6)
  --timeout <ms>             Per-download timeout (default: 30000)
  --keep-staged-metadata     Leave the generated CMDT source on disk for review
  --yes                      Skip the confirmation prompt
  -h, --help                 Show this help

Examples:
  node upload-swatches.js --workspace-id 0Zu000000000001AAA --target-org <alias> \\
                          --file ./color_swatch_list.csv --dry-run

  node upload-swatches.js --workspace-id 0Zu000000000001AAA --target-org <alias> \\
                          --file ./color_swatch_list.csv --confirm-deploy
`;

const FLAGS = new Set([
  '--confirm-deploy', '--dry-run', '--cleanup-test-upload',
  '--keep-staged-metadata', '--yes', '-h', '--help',
]);

const VALUED = new Set([
  '--workspace-id', '--target-org', '--file', '--folder', '--max-rows',
  '--cache-dir', '--out-dir', '--pace', '--download-concurrency', '--timeout',
  '--metadata-out',
]);

// Never returns: a bad invocation must not fall through into a run.
function fail(message) {
  exitSync(2, `Error: ${message}\n\n${USAGE}`);
}

function positiveInt(raw, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

// Workspace ids are 15 or 18 characters. Checking the prefix catches the
// commonest mistake by far - pasting a channel id (0ap) or a site id (0DM)
// where the content space belongs - before anything is downloaded.
const WORKSPACE_ID_RE = /^0Zu[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (FLAGS.has(token)) {
      raw[token] = true;
    } else if (VALUED.has(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${token} requires a value`);
      raw[token] = value;
      i++;
    } else {
      fail(`Unknown argument "${token}"`);
    }
  }

  if (raw['-h'] || raw['--help']) exitSync(0, USAGE);

  const workspaceId = raw['--workspace-id'];
  const orgAlias = raw['--target-org'];
  const file = raw['--file'];

  if (!workspaceId) fail('--workspace-id is required');
  if (!orgAlias) fail('--target-org is required');
  if (!file) fail('--file is required');

  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    fail(
      `--workspace-id "${workspaceId}" is not a content space id. ` +
      'It should start with 0Zu (a 0ap id is a CMS channel and a 0DM id is a site).'
    );
  }
  if (!ORG_ALIAS_RE.test(orgAlias)) {
    fail(`--target-org "${orgAlias}" must start with a letter or digit and contain only letters, digits, dot, dash, underscore`);
  }

  const csvPath = path.resolve(file);
  if (!fs.existsSync(csvPath)) fail(`--file "${file}" does not exist (looked for ${csvPath})`);
  if (!fs.statSync(csvPath).isFile()) fail(`--file "${file}" is not a file`);

  const dryRun = raw['--dry-run'] === true;
  const confirmDeploy = raw['--confirm-deploy'] === true;

  return {
    workspaceId,
    orgAlias,
    csvPath,
    folderId: raw['--folder'] || null,
    dryRun,
    confirmDeploy,
    cleanupTestUpload: raw['--cleanup-test-upload'] === true,
    keepStagedMetadata: raw['--keep-staged-metadata'] === true,
    assumeYes: raw['--yes'] === true,
    maxRows: raw['--max-rows'] ? positiveInt(raw['--max-rows'], '--max-rows') : null,
    metadataOut: raw['--metadata-out'] ? path.resolve(raw['--metadata-out']) : null,
    cacheDir: path.resolve(raw['--cache-dir'] || '.image-cache'),
    outDir: path.resolve(raw['--out-dir'] || process.cwd()),
    paceMs: raw['--pace'] ? positiveInt(raw['--pace'], '--pace', { min: 0, max: 60000 }) : 300,
    downloadConcurrency: raw['--download-concurrency']
      ? positiveInt(raw['--download-concurrency'], '--download-concurrency', { min: 1, max: 16 })
      : 6,
    timeoutMs: raw['--timeout'] ? positiveInt(raw['--timeout'], '--timeout', { min: 1000, max: 300000 }) : 30000,
  };
}

module.exports = { parseArgs, USAGE, WORKSPACE_ID_RE };
