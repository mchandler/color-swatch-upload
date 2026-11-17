#!/usr/bin/env node
'use strict';

const fs = require('fs');

const { parseArgs } = require('./lib/args');
const { createSession } = require('./lib/auth');
const { createClient, sleep } = require('./lib/http');
const { loadColours, groupBySourceUrl } = require('./lib/csv-load');
const { downloadAll } = require('./lib/download');
const { createBinaryContent, publish, UploadVerificationError } = require('./lib/cms-binary');
const { fileName } = require('./lib/naming');
const org = require('./lib/org');
const cmdt = require('./lib/cmdt');
const { retireContent, TEST_UPLOAD_TITLE } = require('./lib/cleanup');
const { createReport, ensureDir } = require('./lib/report');
const { createProgress, formatBytes } = require('./lib/progress');
const { ask } = require('./lib/prompt');
const { exitAfterFlush } = require('./lib/exit');

const PUBLISH_DESCRIPTION = 'Colour swatch upload';
const PROGRESS_EVERY = 10;

function heading(text) {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

// The org is named in full at the point of no return. There is no allowlist of
// permitted aliases, so this banner is the only thing standing between a typo
// and writing to the wrong org - it names the alias, the resolved login user
// and instance, the workspace by name, and the counts.
async function confirm(options, session, workspace, plan) {
  const sess = await session.get();

  heading('About to run');
  console.log(`  Org alias       ${options.orgAlias}`);
  console.log(`  Instance        ${sess.instanceUrl}`);
  console.log(`  Login user      ${sess.username || 'unknown'}`);
  console.log(`  Workspace       ${workspace.name} (${workspace.id})`);
  console.log(`  Colours in CSV  ${plan.total}`);
  console.log(`  To upload       ${plan.toUpload}`);
  console.log(`  To adopt        ${plan.toAdopt}`);
  console.log(`  Already in CMS  ${plan.reused}`);
  console.log(`  CMDT inserts    ${plan.cmdtInserts}`);
  console.log(`  CMDT updates    ${plan.cmdtUpdates}`);
  console.log(`  Custom metadata ${options.dryRun
    ? 'skipped (--dry-run)'
    : options.confirmDeploy ? 'WILL BE DEPLOYED' : 'skipped (no --confirm-deploy)'}`);

  if (options.dryRun) {
    console.log('\n  Dry run: nothing will be uploaded, published or deployed.');
  }
  if (options.assumeYes) return true;

  const answer = await ask('\nProceed? (yes/no) ', 'no');
  return /^y(es)?$/i.test(answer);
}

function reportRowFor(row, fields) {
  return {
    line: row.line,
    color: row.colour,
    sourceUrl: row.sourceUrl,
    title: row.title,
    urlName: row.urlName,
    cmdtRecord: row.devName,
    contentKey: '',
    contentId: '',
    action: '',
    published: '',
    cmdtAction: '',
    bytes: '',
    note: '',
    ...fields,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.outDir);

  const report = createReport(options.orgAlias, options.outDir);

  heading('Reading the colour list');
  const { rows: allRows, skipped, collisions, colourColumn, urlColumn } = loadColours(options.csvPath);
  console.log(`  ${options.csvPath}`);
  console.log(`  Columns: "${colourColumn}" and "${urlColumn}"`);
  console.log(`  ${allRows.length} usable colour(s), ${skipped.length} skipped`);

  // A skipped row is a reported outcome, not a run failure. Routing these
  // through the error channel would make a successful run exit non-zero over a
  // trailing blank line in a spreadsheet export.
  for (const item of skipped) {
    console.log(`  ! line ${item.line}: ${item.reason}${item.detail ? ` (${item.detail})` : ''} - "${item.colour}"`);
    report.row({
      line: item.line, color: item.colour, sourceUrl: item.sourceUrl, title: '', urlName: '',
      cmdtRecord: '', contentKey: '', contentId: '', action: 'skipped', published: '',
      cmdtAction: 'skipped', bytes: '', note: item.detail || item.reason,
    });
  }

  // Two colours that slugify to one urlName would fight over a single CMS
  // record, so the run stops rather than producing a mapping where one of them
  // silently points at the other's image.
  if (collisions.length > 0) {
    heading('Name collisions');
    for (const c of collisions) {
      console.error(`  ${c.urlName} <- ${c.colours.join(', ')}`);
    }
    console.error('\n  These colours produce the same CMS API Name. Rename or remove one of each pair and re-run.');
    report.write();
    return 2;
  }

  const rows = options.maxRows ? allRows.slice(0, options.maxRows) : allRows;
  if (rows.length === 0) {
    console.error('  Nothing to do.');
    report.write();
    return 1;
  }

  heading('Checking the org');
  const session = createSession(options.orgAlias);
  const client = createClient(session);

  const workspace = await org.verifyWorkspace(client, options.workspaceId);
  console.log(`  Workspace       ${workspace.name}`);
  // The type is only required when this run will write records into this org.
  // Uploading images to an org that lacks it - to obtain that org's content
  // keys and emit the records as files for a pipeline - is a supported flow.
  const cmdtInfo = await org.verifyCmdt(client, { required: options.confirmDeploy });
  console.log(`  Metadata type   ${cmdtInfo.present ? `${cmdtInfo.type} present` : `${cmdtInfo.type} ABSENT (records will not be written here)`}`);

  const existing = await org.findExistingSwatches(client, options.workspaceId);
  console.log(`  Existing swatch content: ${existing.size}`);
  const adoptable = await org.findByExternalIds(client, options.workspaceId, rows.map((r) => r.externalId));
  console.log(`  Content from earlier runs: ${adoptable.size}`);
  // Querying a type that does not exist is an error, so an absent type means
  // there are no existing rows by definition.
  const liveCmdt = cmdtInfo.present ? await org.readCmdtRows(client) : new Map();
  console.log(`  Existing metadata rows:  ${cmdtInfo.present ? liveCmdt.size : 'n/a'}`);

  // Three outcomes per colour, in order of preference:
  //
  //   reused   a published swatch already carries this UrlName
  //   adopt    content exists from an earlier run but is not published, so it
  //            only needs publishing - re-creating it would hit
  //            DUPLICATE_VALUE on the externalId and fail forever
  //   upload   nothing exists yet
  const toUpload = [];
  const toAdopt = [];
  const reused = [];
  for (const row of rows) {
    const match = existing.get(row.urlName);
    if (match && match.isPublished && match.contentKey) {
      reused.push({ ...row, contentKey: match.contentKey, contentId: match.contentId });
      continue;
    }
    const prior = adoptable.get(row.externalId);
    if (prior && prior.contentId) {
      toAdopt.push({ ...row, contentKey: prior.contentKey, contentId: prior.contentId, isPublished: prior.isPublished });
      continue;
    }
    toUpload.push(row);
  }

  // One pass over every colour, counting what the metadata step will do. A
  // colour being uploaded has no key yet, so it counts as a write either way:
  // an insert when no row exists, an update when one does.
  const plannedKeys = new Map(
    [...reused, ...toAdopt].filter((r) => r.contentKey).map((r) => [r.colour.toLowerCase(), r.contentKey])
  );
  let cmdtInserts = 0;
  let cmdtUpdates = 0;
  for (const row of rows) {
    const live = liveCmdt.get(row.colour.toLowerCase());
    const key = plannedKeys.get(row.colour.toLowerCase());
    if (!live) cmdtInserts++;
    else if (!key || live.contentKey !== key) cmdtUpdates++;
  }

  const proceed = await confirm(options, session, workspace, {
    total: rows.length,
    toUpload: toUpload.length,
    toAdopt: toAdopt.length,
    reused: reused.length,
    cmdtInserts,
    cmdtUpdates,
  });
  if (!proceed) {
    console.log('\n  Cancelled. Nothing was changed.');
    report.write();
    return 1;
  }

  // Colours sharing one source image download once. The cache is keyed on the
  // URL, so a re-run costs nothing either.
  heading('Downloading source images');
  const groups = groupBySourceUrl(toUpload);
  const downloads = new Map();
  const downloadProgress = createProgress('download', groups.size, { printEvery: PROGRESS_EVERY });
  let downloadIndex = 0;
  let downloadedBytes = 0;

  await downloadAll(
    [...groups.keys()],
    {
      cacheDir: options.cacheDir,
      timeoutMs: options.timeoutMs,
      concurrency: options.downloadConcurrency,
    },
    (sourceUrl, result, error) => {
      if (result) {
        downloads.set(sourceUrl, result);
        downloadedBytes += result.bytes;
        downloadProgress.record({ ok: 1 });
      } else {
        downloadProgress.record({ fail: 1 });
        for (const member of groups.get(sourceUrl) || []) {
          report.error({
            ...member, phase: 'download',
            errorCode: error.code || 'DOWNLOAD_FAILED', errorMessage: error.message,
          });
        }
        const names = (groups.get(sourceUrl) || []).map((m) => m.colour).join(', ');
        console.log(`  ! ${error.code || 'error'}: ${names} - ${error.message}`);
      }
      downloadProgress.print(downloadIndex++);
    }
  );
  console.log(`  ${downloads.size}/${groups.size} image(s) available, ${formatBytes(downloadedBytes)}`);

  const published = [];
  let adoptedCount = 0;
  let uploadedCount = 0;
  let unconfirmedCount = 0;
  let imageMissingCount = 0;

  // Publishing is a deployment, so the mapping is only allowed to name content
  // whose isPublished has been re-read. Anything unconfirmed is reported and
  // left out of the metadata step rather than mapped optimistically.
  async function publishAndConfirm(row, contentId) {
    await publish(client, [contentId], PUBLISH_DESCRIPTION);
    return org.confirmPublished(client, contentId);
  }

  if (toAdopt.length > 0) {
    heading(options.dryRun ? 'Adoption plan (dry run)' : 'Publishing content from earlier runs');
    for (const row of toAdopt) {
      if (options.dryRun) {
        report.row(reportRowFor(row, {
          contentKey: row.contentKey || '', contentId: row.contentId,
          action: row.isPublished ? 'would-reuse' : 'would-publish',
          published: row.isPublished ? 'yes' : 'no', cmdtAction: 'would-write',
          note: 'content already exists from an earlier run',
        }));
        continue;
      }

      try {
        // Even an already-published row is re-read when it has no key: the
        // variant row that fed the adopt plan can carry a null
        // ManagedContentKey, and the content read is where one is recovered.
        const state = row.isPublished && row.contentKey
          ? { published: true, contentKey: row.contentKey }
          : await publishAndConfirm(row, row.contentId);

        const contentKey = row.contentKey || state.contentKey || '';

        if (!state.published) {
          report.error({
            ...row, phase: 'publish', errorCode: 'NOT_PUBLISHED',
            errorMessage: `publish did not report isPublished for ${row.contentId}`,
          });
          report.row(reportRowFor(row, {
            contentKey, contentId: row.contentId, action: 'adopted',
            published: 'no', cmdtAction: 'skipped', note: 'publish not confirmed; not mapped',
          }));
          console.log(`  ! ${row.colour}: publish not confirmed`);
          continue;
        }

        // A colour published but keyless cannot be mapped. Reporting it as an
        // error is the point: every other unmappable outcome fails the run,
        // and letting this one pass silently was exactly the trap - the
        // content goes live and the storefront still resolves nothing.
        if (!contentKey) {
          report.error({
            ...row, phase: 'adopt', errorCode: 'NO_CONTENT_KEY',
            errorMessage: `published ${row.contentId} but no contentKey could be read for it`,
          });
          report.row(reportRowFor(row, {
            contentId: row.contentId, action: 'adopted', published: 'yes',
            cmdtAction: 'not-mapped', note: 'no content key available; not mapped',
          }));
          console.log(`  ! ${row.colour}: published but no content key could be read`);
          continue;
        }

        published.push({ ...row, contentKey });
        adoptedCount++;
        report.row(reportRowFor(row, {
          contentKey, contentId: row.contentId, action: 'adopted',
          published: 'yes', cmdtAction: 'pending',
          note: 'existing content published by this run',
        }));
      } catch (e) {
        report.error({ ...row, phase: 'publish', errorCode: e.status ? `HTTP_${e.status}` : 'PUBLISH_FAILED', errorMessage: e.message });
        report.row(reportRowFor(row, {
          contentKey: row.contentKey || '', contentId: row.contentId, action: 'failed',
          published: 'no', cmdtAction: 'skipped', note: e.message.slice(0, 300),
        }));
        console.log(`  ! ${row.colour}: ${e.message}`);
      }

      // Publishing is a CMS write, so this loop paces like the upload loop
      // rather than firing a publish plus several confirmation reads per
      // colour back to back.
      if (options.paceMs > 0) await sleep(options.paceMs);
    }
  }

  heading(options.dryRun ? 'Upload plan (dry run)' : 'Uploading and publishing');
  const uploadProgress = createProgress('upload', toUpload.length, { printEvery: PROGRESS_EVERY });

  for (let i = 0; i < toUpload.length; i++) {
    const row = toUpload[i];
    const image = downloads.get(row.sourceUrl);

    if (!image) {
      uploadProgress.record({ skip: 1 });
      imageMissingCount++;
      report.row(reportRowFor(row, {
        action: 'skipped', published: 'no', cmdtAction: 'skipped',
        note: 'source image unavailable',
      }));
      uploadProgress.print(i);
      continue;
    }

    if (options.dryRun) {
      uploadProgress.record({ skip: 1 });
      report.row(reportRowFor(row, {
        action: 'would-upload', published: 'no', cmdtAction: 'would-write', bytes: image.bytes,
      }));
      uploadProgress.print(i);
      continue;
    }

    try {
      const bytes = fs.readFileSync(image.path);
      const created = await createBinaryContent(client, {
        workspaceId: options.workspaceId,
        folderId: options.folderId,
        title: row.title,
        apiName: row.apiName,
        urlName: row.urlName,
        externalId: row.externalId,
        altText: row.altText,
        mimeType: image.mimeType,
        fileName: fileName(row.colour, image.mimeType),
        bytes,
      });

      const state = await publishAndConfirm(row, created.managedContentId);
      if (!state.published) {
        uploadProgress.record({ fail: 1 });
        unconfirmedCount++;
        report.error({
          ...row, phase: 'publish', errorCode: 'NOT_PUBLISHED',
          errorMessage: `created ${created.contentKey} but isPublished never came back true`,
        });
        report.row(reportRowFor(row, {
          contentKey: created.contentKey, contentId: created.managedContentId,
          action: 'uploaded', published: 'no', cmdtAction: 'skipped', bytes: created.bytes,
          note: 'publish not confirmed; not mapped',
        }));
        console.log(`  ! ${row.colour}: uploaded but publish not confirmed`);
        uploadProgress.print(i);
        continue;
      }

      published.push({ ...row, contentKey: created.contentKey, contentId: created.managedContentId });
      uploadedCount++;
      uploadProgress.record({ ok: 1 });
      report.row(reportRowFor(row, {
        contentKey: created.contentKey, contentId: created.managedContentId,
        action: 'uploaded', published: 'yes', cmdtAction: 'pending', bytes: created.bytes,
      }));
    } catch (e) {
      uploadProgress.record({ fail: 1 });
      const code = e instanceof UploadVerificationError ? 'BYTES_MISMATCH'
        : (e.status ? `HTTP_${e.status}` : 'UPLOAD_FAILED');
      report.error({ ...row, phase: 'upload', errorCode: code, errorMessage: e.message });
      report.row(reportRowFor(row, {
        action: 'failed', published: 'no', cmdtAction: 'skipped', bytes: image.bytes,
        note: `${code}: ${e.message}`.slice(0, 300),
      }));
      console.log(`  ! ${row.colour}: ${e.message}`);
    }

    uploadProgress.print(i);
    if (options.paceMs > 0 && i + 1 < toUpload.length) await sleep(options.paceMs);
  }

  for (const row of reused) {
    const live = liveCmdt.get(row.colour.toLowerCase());
    const alreadyCorrect = live && live.contentKey === row.contentKey;
    report.row(reportRowFor(row, {
      contentKey: row.contentKey, contentId: row.contentId, action: 'reused',
      published: 'yes',
      // In a dry run nothing is pending - the row either already matches or
      // would be written - and saying "pending" would read as in flight.
      cmdtAction: alreadyCorrect ? 'unchanged' : (options.dryRun ? 'would-write' : 'pending'),
      note: 'already published in this workspace',
    }));
  }

  // Every colour with confirmed-published content gets a metadata record,
  // whether the key came from this run or from content already in place.
  const records = [...reused, ...published]
    .filter((row) => row.contentKey)
    .map((row) => ({
      devName: row.devName,
      label: row.label,
      colour: row.colour,
      contentKey: row.contentKey,
    }));

  const unchanged = records.filter((r) => {
    const live = liveCmdt.get(r.colour.toLowerCase());
    return live && live.contentKey === r.contentKey;
  });
  const needWrite = records.filter((r) => {
    const live = liveCmdt.get(r.colour.toLowerCase());
    return !live || live.contentKey !== r.contentKey;
  });

  for (const r of unchanged) report.update(r.colour, { cmdtAction: 'unchanged' });

  heading('Custom metadata');
  console.log(`  ${records.length} colour(s) with a content key`);
  console.log(`  ${unchanged.length} already correct, ${needWrite.length} to write`);

  // Emitting the files is independent of deploying them. The whole set is
  // written, not just what this org still needs, because the output is meant
  // to be committed and promoted as the complete mapping for this org's keys.
  if (options.metadataOut) {
    if (options.dryRun) {
      console.log('  Skipped --metadata-out: a dry run has no content keys to write.');
    } else if (records.length === 0) {
      console.log('  Skipped --metadata-out: no colour has a content key.');
    } else {
      const staged = cmdt.stageDeployment(records, { outDir: options.metadataOut });
      console.log(`  Wrote ${staged.fullNames.length} record file(s) to ${staged.sourceDir}`);
      console.log('  Not deployed from here. Commit these and promote them through your pipeline.');
    }
  }

  let verifyResult = null;

  if (options.dryRun) {
    console.log('  Skipped: --dry-run');
  } else if (!options.confirmDeploy) {
    console.log('  Skipped: --confirm-deploy was not passed.');
    console.log('  Writing custom metadata is a metadata deploy, so it is opt-in per run.');
    console.log('  The CMS content above is in place; re-run with --confirm-deploy to write the rows.');
    for (const r of needWrite) report.update(r.colour, { cmdtAction: 'not-written' });
  } else if (needWrite.length === 0) {
    console.log('  Nothing to write.');
  } else {
    console.log(`  Deploying ${needWrite.length} record(s) to ${options.orgAlias}...`);
    try {
      const deployResult = await cmdt.deploy(needWrite, options.orgAlias, {
        keepDir: options.keepStagedMetadata,
      });
      console.log(`  Deploy ${deployResult.deployId || 'completed'}`);
      if (deployResult.stagedAt) console.log(`  Staged source kept at ${deployResult.stagedAt}`);

      // A successful deploy is not proof the rows are readable, so they are
      // queried back and compared before the run calls itself a success.
      verifyResult = await cmdt.verify(client, needWrite, org.readCmdtRows);
      console.log(`  Verified ${verifyResult.verified}/${needWrite.length} by readback`);

      const failed = new Set();
      for (const miss of verifyResult.missing) {
        failed.add(miss.colour.toLowerCase());
        report.update(miss.colour, { cmdtAction: 'not-readable' });
        report.error({
          colour: miss.colour, phase: 'cmdt-verify',
          errorCode: 'NOT_READABLE', errorMessage: `${miss.devName} not returned by query after deploy`,
        });
      }
      for (const bad of verifyResult.mismatched) {
        failed.add(bad.colour.toLowerCase());
        report.update(bad.colour, { cmdtAction: 'key-mismatch', note: `org holds ${bad.actualContentKey}` });
        report.error({
          colour: bad.colour, phase: 'cmdt-verify', errorCode: 'KEY_MISMATCH',
          errorMessage: `expected ${bad.contentKey}, org holds ${bad.actualContentKey}`,
        });
      }
      for (const r of needWrite) {
        if (!failed.has(r.colour.toLowerCase())) report.update(r.colour, { cmdtAction: 'written' });
      }
    } catch (e) {
      console.error(`  ! Deploy failed: ${e.message}`);
      for (const r of needWrite) report.update(r.colour, { cmdtAction: 'deploy-failed' });
      report.error({ phase: 'cmdt-deploy', errorCode: 'DEPLOY_FAILED', errorMessage: e.message });
    }
  }

  if (options.cleanupTestUpload && !options.dryRun) {
    heading('Legacy test upload');
    const found = await org.findTestUpload(client, options.workspaceId, TEST_UPLOAD_TITLE);
    if (found.length === 0) {
      console.log(`  Not present: "${TEST_UPLOAD_TITLE}"`);
    } else {
      // Retiring the old content before Acorn's mapping is verifiably in place
      // would leave the colour with nothing to render. "A key exists in
      // memory" is not enough: the metadata row has to have been deployed and
      // read back.
      const acornVerified = options.confirmDeploy
        && records.some((r) => r.colour.toLowerCase() === 'acorn')
        && (
          unchanged.some((r) => r.colour.toLowerCase() === 'acorn')
          || (verifyResult
            && !verifyResult.missing.some((r) => r.colour.toLowerCase() === 'acorn')
            && !verifyResult.mismatched.some((r) => r.colour.toLowerCase() === 'acorn'))
        );

      if (!acornVerified) {
        console.log('  Left alone: Acorn has no verified metadata row yet.');
        console.log('  Re-run with --confirm-deploy once Swatch - Acorn is mapped.');
      } else {
        for (const item of found) {
          const outcome = await retireContent(client, item);
          console.log(`  ${outcome.title}: unpublished=${outcome.unpublished} deleted=${outcome.deleted}${outcome.note ? ` (${outcome.note})` : ''}`);
          // The API offers no deletion for CMS content, so a refused delete is
          // the documented outcome, not a run failure. It is reported on the
          // Acorn row so the remaining manual step is visible.
          if (!outcome.deleted) {
            report.update('Acorn', { note: outcome.note || 'legacy test content unpublished; delete it in the CMS UI' });
          }
          if (!outcome.unpublished && item.isPublished) {
            report.error({
              colour: 'Acorn', phase: 'cleanup', errorCode: 'UNPUBLISH_FAILED',
              errorMessage: outcome.note || 'could not unpublish the legacy test content',
            });
          }
        }
      }
    }
  }

  heading('Summary');
  console.log(`  Colours processed   ${rows.length}`);
  console.log(`  Uploaded            ${uploadedCount}`);
  console.log(`  Adopted + published ${adoptedCount}`);
  console.log(`  Reused existing     ${reused.length}`);
  if (unconfirmedCount > 0) {
    // These contents exist in CMS but were not mapped, so the count has to be
    // visible rather than hidden inside "uploaded".
    console.log(`  Created, unpublished ${unconfirmedCount}`);
  }
  console.log(`  Metadata written    ${verifyResult ? verifyResult.verified : 0}`);
  console.log(`  Metadata unchanged  ${unchanged.length}`);
  console.log(`  Skipped rows        ${skipped.length + imageMissingCount}`);
  console.log(`  Errors              ${report.errorCount}`);

  const files = report.write();
  for (const file of files) console.log(`  Report: ${file}`);

  if (report.errorCount > 0) return 1;
  if (!options.dryRun && options.confirmDeploy && verifyResult
      && verifyResult.verified < needWrite.length) return 1;
  return 0;
}

main()
  .then((code) => exitAfterFlush(code))
  .catch((e) => {
    console.error(`\nError: ${e.message}`);
    if (process.env.SWATCH_DEBUG) console.error(e.stack);
    exitAfterFlush(1);
  });
