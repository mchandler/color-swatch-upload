'use strict';

const { API_VERSION, sleep } = require('./http');
const { URL_PREFIX } = require('./naming');

const QUERY_PATH = `/services/data/${API_VERSION}/query`;

const CMDT_TYPE = 'ECOM_Color_Swatch__mdt';
const CMDT_REQUIRED_FIELDS = ['Color__c', 'ContentKey__c'];

// SOQL IN lists are chunked, matching the sibling projects' convention.
const SOQL_IN_CHUNK = 200;

// SOQL goes over REST with the CLI's own token rather than through `sf data
// query`, because quoting a SOQL string on cmd.exe is its own small hell and
// the token is already in hand for the CMS calls.
async function query(client, soql) {
  const rows = [];
  let path = `${QUERY_PATH}?q=${encodeURIComponent(soql)}`;
  while (path) {
    const page = await client.get(path);
    if (page && Array.isArray(page.records)) rows.push(...page.records);
    path = page && page.nextRecordsUrl ? page.nextRecordsUrl : null;
  }
  return rows;
}

function escapeSoqlLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// The workspace id is typed on the command line, so confirm it names a real
// content space before downloading 81 images against it.
async function verifyWorkspace(client, workspaceId) {
  const rows = await query(
    client,
    `SELECT Id, Name FROM ManagedContentSpace WHERE Id = '${escapeSoqlLiteral(workspaceId)}'`
  );
  if (rows.length === 0) {
    throw new Error(
      `Workspace ${workspaceId} does not exist in this org, or the running user cannot see it. ` +
      'Check the id in Setup > Digital Experiences > All Workspaces.'
    );
  }
  return { id: rows[0].Id, name: rows[0].Name };
}

// ECOM_Color_Swatch__mdt is created by hand in each org, so a missing type is
// an expected operator error and gets a plain message rather than a stack.
//
// `required` is false when the run will not write records into this org - the
// case that matters is uploading images to an org that does not have the type
// yet and emitting the XML for a pipeline to carry. Refusing there would block
// the only way to obtain that org's content keys.
async function verifyCmdt(client, { required = true } = {}) {
  const entity = await query(
    client,
    `SELECT QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName = '${CMDT_TYPE}'`
  );
  if (entity.length === 0) {
    if (!required) return { type: CMDT_TYPE, present: false, label: null };
    throw new Error(
      `${CMDT_TYPE} does not exist in this org. Create the custom metadata type (with ${CMDT_REQUIRED_FIELDS.join(' and ')}) ` +
      'before running this tool, or re-run without --confirm-deploy and with --metadata-out to emit the records as files.'
    );
  }

  const fields = await query(
    client,
    `SELECT QualifiedApiName, DataType FROM FieldDefinition ` +
    `WHERE EntityDefinition.QualifiedApiName = '${CMDT_TYPE}'`
  );
  const fieldNames = new Set(fields.map((f) => f.QualifiedApiName));
  const missing = CMDT_REQUIRED_FIELDS.filter((f) => !fieldNames.has(f));
  if (missing.length > 0) {
    // A type that exists but lacks the fields is broken either way: the XML
    // this tool writes names them, so it would fail wherever it is deployed.
    throw new Error(`${CMDT_TYPE} is missing required field(s): ${missing.join(', ')}`);
  }

  return { type: CMDT_TYPE, present: true, label: entity[0].Label };
}

// Existing swatch content in this workspace, keyed by UrlName. This is the
// admin-context query the naming convention exists to serve: UrlName LIKE
// 'swatch-%' selects swatches and nothing else, where a bare colour name would
// also match product images such as "Acorn Aerosol Spray Paint".
//
// Only published variants are treated as usable. Draft content does not render
// on the storefront, so a draft is a gap to fill, not a row to reuse.
async function findExistingSwatches(client, workspaceId) {
  const rows = await query(
    client,
    'SELECT Id, Name, UrlName, ManagedContentKey, ManagedContentId, IsPublished, ManagedContentVariantStatus ' +
    'FROM ManagedContentVariant ' +
    `WHERE UrlName LIKE '${URL_PREFIX}%' ` +
    `AND ManagedContent.AuthoredManagedContentSpaceId = '${escapeSoqlLiteral(workspaceId)}' ` +
    'ORDER BY UrlName'
  );

  const byUrlName = new Map();
  for (const row of rows) {
    // Several variants can share a UrlName across languages; prefer a
    // published one and otherwise keep the first seen.
    const current = byUrlName.get(row.UrlName);
    if (!current || (row.IsPublished === true && current.isPublished !== true)) {
      byUrlName.set(row.UrlName, {
        urlName: row.UrlName,
        title: row.Name,
        contentKey: row.ManagedContentKey,
        contentId: row.ManagedContentId,
        isPublished: row.IsPublished === true,
        status: row.ManagedContentVariantStatus,
      });
    }
  }
  return byUrlName;
}

// Content this tool created on an earlier run, keyed by externalId.
//
// This lookup is a hard requirement, not an optimisation. Creating a second
// content with an externalId that already exists fails with 400
// DUPLICATE_VALUE (../sf-cms-url-to-binary/PROJECT.md 3.6), so a colour whose
// create succeeded but whose publish or byte check failed would otherwise be
// unrecoverable: every later run would try to create it again and fail
// forever. Finding it here lets the run adopt the draft and just publish it.
async function findByExternalIds(client, workspaceId, externalIds) {
  const ids = [...new Set(externalIds)].filter(Boolean);
  const byExternalId = new Map();

  for (let i = 0; i < ids.length; i += SOQL_IN_CHUNK) {
    const chunk = ids.slice(i, i + SOQL_IN_CHUNK);
    const list = chunk.map((id) => `'${escapeSoqlLiteral(id)}'`).join(',');
    const rows = await query(
      client,
      'SELECT ManagedContentKey, ManagedContentId, IsPublished, ManagedContent.ExternalId ' +
      'FROM ManagedContentVariant ' +
      `WHERE ManagedContent.AuthoredManagedContentSpaceId = '${escapeSoqlLiteral(workspaceId)}' ` +
      `AND ManagedContent.ExternalId IN (${list})`
    );

    for (const row of rows) {
      const externalId = row.ManagedContent && row.ManagedContent.ExternalId;
      if (!externalId) continue;
      const current = byExternalId.get(externalId);
      // Prefer a published variant when a colour has more than one.
      if (!current || (row.IsPublished === true && current.isPublished !== true)) {
        byExternalId.set(externalId, {
          externalId,
          contentKey: row.ManagedContentKey,
          contentId: row.ManagedContentId,
          isPublished: row.IsPublished === true,
        });
      }
    }
  }

  return byExternalId;
}

// Publishing is a deployment, so a 2xx on the publish call does not mean the
// content is live (../sf-cms-url-to-binary/PROJECT.md 3.7). This re-reads the
// content and polls briefly, because the mapping must never point at content
// that does not render for a guest.
// Returns the contentKey it read as well as the verdict. Adopted content comes
// from a SOQL variant row whose ManagedContentKey can be null, and this read is
// the one place a key can be recovered - without it such a colour would be
// published and then silently left out of the mapping.
async function confirmPublished(client, contentId, { attempts = 8, delayMs = 3000 } = {}) {
  let contentKey = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    let content;
    try {
      content = await client.get(`/services/data/${API_VERSION}/connect/cms/contents/${contentId}`);
    } catch (e) {
      // A transient read failure is not evidence either way; keep polling and
      // let the caller treat an exhausted loop as unconfirmed.
      continue;
    }
    if (content && content.contentKey) contentKey = content.contentKey;
    if (content && content.isPublished === true) {
      return { published: true, attempts: attempt + 1, contentKey };
    }
  }
  return { published: false, attempts, contentKey };
}

// Current CMDT rows, keyed by lowercase colour, so the run can tell an insert
// from an update and skip rows whose key has not changed.
async function readCmdtRows(client) {
  const rows = await query(
    client,
    `SELECT Id, DeveloperName, MasterLabel, Color__c, ContentKey__c FROM ${CMDT_TYPE}`
  );
  const byColour = new Map();
  for (const row of rows) {
    byColour.set(String(row.Color__c || '').toLowerCase(), {
      devName: row.DeveloperName,
      colour: row.Color__c,
      contentKey: row.ContentKey__c,
    });
  }
  return byColour;
}

// The test upload predates the naming convention, so it is found by title
// rather than by UrlName prefix.
async function findTestUpload(client, workspaceId, title) {
  const rows = await query(
    client,
    'SELECT Id, Name, UrlName, ManagedContentKey, ManagedContentId, IsPublished ' +
    'FROM ManagedContentVariant ' +
    `WHERE Name = '${escapeSoqlLiteral(title)}' ` +
    `AND ManagedContent.AuthoredManagedContentSpaceId = '${escapeSoqlLiteral(workspaceId)}'`
  );
  return rows.map((row) => ({
    title: row.Name,
    urlName: row.UrlName,
    contentKey: row.ManagedContentKey,
    contentId: row.ManagedContentId,
    isPublished: row.IsPublished === true,
  }));
}

module.exports = {
  query, escapeSoqlLiteral, verifyWorkspace, verifyCmdt,
  findExistingSwatches, findByExternalIds, confirmPublished, readCmdtRows, findTestUpload,
  CMDT_TYPE, CMDT_REQUIRED_FIELDS, SOQL_IN_CHUNK,
};
