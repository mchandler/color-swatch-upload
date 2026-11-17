'use strict';

const { API_VERSION } = require('./http');
const { unpublish } = require('./cms-binary');

const CONTENTS_PATH = `/services/data/${API_VERSION}/connect/cms/contents`;

// The legacy test upload in ecommpilot, from before the naming convention.
const TEST_UPLOAD_TITLE = 'Acorn (Test Swatch Upload)';

// Retiring CMS content is not symmetrical with creating it. Unpublishing is
// supported and reversible; deletion through the Connect API is not available,
// which the sibling sf-cms-updates-from-salsify project documents the same way.
// Rather than claim a delete it cannot perform, this attempts one after the
// unpublish and reports exactly what the platform allowed, so the operator
// knows whether a manual removal in the CMS UI is still outstanding.
async function retireContent(client, item) {
  const outcome = { contentId: item.contentId, title: item.title, unpublished: false, deleted: false, note: '' };

  if (item.isPublished) {
    try {
      await unpublish(client, [item.contentId]);
      outcome.unpublished = true;
    } catch (e) {
      outcome.note = `unpublish failed: ${e.message}`.slice(0, 300);
      return outcome;
    }
  } else {
    outcome.note = 'already unpublished';
  }

  try {
    await client.del(`${CONTENTS_PATH}/${item.contentId}`);
    outcome.deleted = true;
  } catch (e) {
    const status = e && e.status ? `HTTP ${e.status}` : 'error';
    outcome.note = [
      outcome.note,
      `delete not performed (${status}) - remove it in the CMS UI if you want it gone`,
    ].filter(Boolean).join('; ').slice(0, 300);
  }

  return outcome;
}

module.exports = { retireContent, TEST_UPLOAD_TITLE };
