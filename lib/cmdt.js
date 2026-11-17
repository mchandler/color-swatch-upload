'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { sleep } = require('./http');
const { CMDT_TYPE } = require('./org');

// Custom metadata records cannot be written with DML or the REST data API -
// they are metadata, so the only route is a Metadata API deploy. This builds a
// throwaway SFDX source directory and hands it to the CLI the operator already
// authenticated, which keeps the tool free of Connected App setup.
//
// A deploy is also why --confirm-deploy is mandatory: unlike the CMS upload,
// this step changes org metadata.

const EXEC_OPTS = {
  maxBuffer: 20 * 1024 * 1024,
  // Same reasoning as lib/auth.js: on Windows let the shell resolve `sf`
  // through PATHEXT, since sf.cmd and sf.exe are both valid installs.
  shell: process.platform === 'win32',
};

const API_VERSION_NUMBER = '64.0';
const DEPLOY_WAIT_MINUTES = 33;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// One record file per colour. `protected` must be false or Apex outside this
// namespace - which includes the storefront LWC's controller - cannot read it.
function buildRecordXml({ label, colour, contentKey }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>${escapeXml(label)}</label>
    <protected>false</protected>
    <values>
        <field>Color__c</field>
        <value xsi:type="xsd:string">${escapeXml(colour)}</value>
    </values>
    <values>
        <field>ContentKey__c</field>
        <value xsi:type="xsd:string">${escapeXml(contentKey)}</value>
    </values>
</CustomMetadata>
`;
}

function buildPackageXml(fullNames) {
  const members = fullNames.map((n) => `        <members>${escapeXml(n)}</members>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
${members}
        <name>CustomMetadata</name>
    </types>
    <version>${API_VERSION_NUMBER}</version>
</Package>
`;
}

// Written under the OS temp directory rather than the project, so a run leaves
// no half-built metadata behind for someone to deploy by accident later.
function stageDeployment(records, { keepDir = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swatch-cmdt-'));
  const sourceDir = path.join(root, 'force-app', 'main', 'default', 'customMetadata');
  fs.mkdirSync(sourceDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'sfdx-project.json'),
    `${JSON.stringify({
      packageDirectories: [{ path: 'force-app', default: true }],
      namespace: '',
      sfdcLoginUrl: 'https://login.salesforce.com',
      sourceApiVersion: API_VERSION_NUMBER,
    }, null, 2)}\n`
  );

  const fullNames = [];
  for (const record of records) {
    const fullName = `${CMDT_TYPE.replace(/__mdt$/, '')}.${record.devName}`;
    fullNames.push(fullName);
    fs.writeFileSync(path.join(sourceDir, `${fullName}.md-meta.xml`), buildRecordXml(record));
  }

  fs.writeFileSync(path.join(sourceDir, 'package.xml'), buildPackageXml(fullNames));

  return {
    root,
    sourceDir,
    fullNames,
    cleanup() {
      if (keepDir) return;
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (_) {
        // A scanner holding a handle on Windows is not worth failing the run
        // over; the OS clears its own temp directory.
      }
    },
  };
}

function runSf(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('sf', args, { ...EXEC_OPTS, cwd }, (err, stdout, stderr) => {
      if (err) {
        let detail = stderr && stderr.trim();
        try {
          const parsed = JSON.parse(stdout);
          const message = parsed && (parsed.message || (parsed.result && parsed.result.message));
          // The CLI reports per-component failures only inside the result, so
          // a bare top-level message would hide which record was rejected.
          const failures = parsed && parsed.result && parsed.result.details
            && parsed.result.details.componentFailures;
          if (Array.isArray(failures) && failures.length > 0) {
            detail = failures
              .slice(0, 10)
              .map((f) => `${f.fullName}: ${f.problem}`)
              .join('; ');
          } else if (message) {
            detail = String(message).trim();
          }
        } catch (_) {
          // Not JSON; stderr already holds whatever there is.
        }
        return reject(new Error(`sf ${args.join(' ')} failed: ${detail || err.message}`));
      }
      resolve(stdout);
    });
  });
}

async function deploy(records, orgAlias, { dryRun = false, keepDir = false } = {}) {
  if (records.length === 0) return { deployed: 0, fullNames: [], checkOnly: dryRun };

  const staged = stageDeployment(records, { keepDir });
  try {
    const args = [
      'project', 'deploy', 'start',
      '--source-dir', path.join('force-app', 'main', 'default', 'customMetadata'),
      '--target-org', orgAlias,
      '--wait', String(DEPLOY_WAIT_MINUTES),
      '--json',
    ];
    if (dryRun) args.push('--dry-run');

    const stdout = await runSf(args, staged.root);
    let result = null;
    try {
      result = JSON.parse(stdout);
    } catch (_) {
      // A successful deploy with unparseable output is still a success; the
      // readback below is what actually proves the rows landed.
    }

    return {
      deployed: records.length,
      fullNames: staged.fullNames,
      checkOnly: dryRun,
      deployId: result && result.result && result.result.id,
      stagedAt: keepDir ? staged.root : null,
    };
  } finally {
    staged.cleanup();
  }
}

// A deploy that reports success is not proof the rows are readable: custom
// metadata writes have been seen to land late in this org family, so the run
// confirms by querying them back and comparing content keys.
//
// The readback retries, because the lag is the whole reason it exists. Checking
// once and failing would accuse a successful deploy of having failed and send
// the operator into a re-run that correctly deploys nothing. Only the records
// not yet accounted for are re-polled, and a wrong key is not retried - that is
// a real mismatch, not latency.
async function verify(client, records, readCmdtRows, { attempts = 5, delayMs = 3000 } = {}) {
  // Only absent rows are re-polled. A row that came back with the wrong key is
  // settled on the spot and accumulates outside the loop - resetting the
  // mismatch list each attempt would discard a real mismatch found on the
  // first pass and report the record as verified.
  let pending = [...records];
  const mismatched = [];

  for (let attempt = 0; attempt < attempts && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(delayMs);

    const live = await readCmdtRows(client);
    const stillPending = [];

    for (const record of pending) {
      const row = live.get(String(record.colour).toLowerCase());
      if (!row) {
        stillPending.push(record);
      } else if (row.contentKey !== record.contentKey) {
        mismatched.push({ ...record, actualContentKey: row.contentKey });
      }
      // Anything else matched, and drops out of the pending set.
    }

    pending = stillPending;
  }

  return {
    verified: records.length - pending.length - mismatched.length,
    missing: pending,
    mismatched,
  };
}

module.exports = {
  deploy, verify, stageDeployment, buildRecordXml, buildPackageXml, escapeXml,
  DEPLOY_WAIT_MINUTES,
};
