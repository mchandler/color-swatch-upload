# color-swatch-upload

Uploads colour swatch images into a Salesforce CMS workspace and records each
one's Content Key in the `ECOM_Color_Swatch__mdt` custom metadata type.

The storefront needs a swatch image beside the Exterior and Interior Colour
values on the product identification pages, and all it has to work with is the
colour name. CMS images can only be fetched by Content Key — the delivery path
rejects the API Name, and the Delivery API ignores `urlNames` as a filter — so a
shopper cannot resolve a swatch by name at runtime. This tool closes that gap
from the admin side: it creates the CMS content, publishes it, and writes the
colour-to-Content-Key mapping that the component reads.

## Install

Nothing to install. The tool has no dependencies and the tests use Node's own
runner, so a clone is ready to use. Requires Node 18 or newer and the `sf` CLI
on PATH with the target org already authorised:

```
sf org login web --alias <alias>
```

The org must already have the `ECOM_Color_Swatch__mdt` custom metadata type with
`Color__c` and `ContentKey__c` fields. The tool verifies this before doing any
work and stops with a plain message if the type or a field is missing — it never
creates schema.

Runs on Windows, macOS and Linux.

## Usage

```
node upload-swatches.js --workspace-id <id> --target-org <alias> --file <path> [options]
```

Start with a dry run, which downloads the images, reports exactly what it would
create, and writes nothing to the org:

```
node upload-swatches.js --workspace-id 0Zu000000000001AAA --target-org <alias> \
                        --file ./color_swatch_list.csv --dry-run
```

Then the real run. Writing custom metadata is a Metadata API deploy, so it is
opt-in per run with `--confirm-deploy`; without that flag the CMS upload still
happens and the mapping step is skipped:

```
node upload-swatches.js --workspace-id 0Zu000000000001AAA --target-org <alias> \
                        --file ./color_swatch_list.csv --confirm-deploy
```

### Input

A CSV with a colour column and a swatch URL column:

```
Color Values,Salsify Swatch
Acorn,https://images.salsify.com/image/upload/s--2SapzLTW--/zewomidx8zym2mmyj9bt
Country Blue,https://images.salsify.com/image/upload/s--mGQS2hcV--/bqvdfinxkdqhkqovzbqo
```

`Color`, `Colour`, `Swatch`, `Url` and `URL` are accepted as alternative header
spellings. Rows with an empty colour or URL are reported and skipped rather than
failing the run.

Several colours may share one image URL — spelling variants such as
`Clay Cannyon` and `Clay Canyon` point at the same Salsify asset. Each colour
still gets its own CMS record, so every value a shopper might see resolves, but
the image downloads once.

### Options

```
--workspace-id <id>        CMS workspace (content space) id, 0Zu...
--target-org <alias>       Org alias as known to the sf CLI
--file <path>              Input CSV
--confirm-deploy           Required to write custom metadata
--dry-run                  Download and report only; writes nothing
--folder <id>              Folder within the workspace for new content
--cleanup-test-upload      Retire the legacy "Acorn (Test Swatch Upload)" content
--max-rows <n>             Process only the first n colours
--cache-dir <path>         Download cache (default: .image-cache)
--out-dir <path>           Where report CSVs are written (default: cwd)
--pace <ms>                Delay between CMS writes (default: 300)
--download-concurrency <n> Parallel source downloads (default: 6)
--timeout <ms>             Per-download timeout (default: 30000)
--keep-staged-metadata     Leave the generated metadata source on disk
--yes                      Skip the confirmation prompt
```

## What it writes

For the colour `Country Blue`:

| Where | Name | Value |
|---|---|---|
| CMS title | | `Swatch - Country Blue` |
| CMS URL Name | | `swatch-country-blue` |
| CMS API Name | | `Swatch_Country_Blue` |
| CMS alt text | | `Country Blue color swatch` |
| CMDT record | | `Swatch_Country_Blue` |
| CMDT | `Color__c` | `Country Blue` |
| CMDT | `ContentKey__c` | the generated Content Key |

The URL Name and the API Name are different shapes on purpose. CMS accepts only
letters, digits and underscores in an API Name, and requires it to begin with a
letter and to avoid doubled or trailing underscores, so a hyphenated value is
rejected outright. Both are capped at 80 characters; a colour long enough to
exceed that is truncated with a short hash of its name so two long colours
cannot collide.

The `swatch-` prefix is load-bearing. It is what lets the tool find existing
swatches on a re-run with `UrlName LIKE 'swatch-%'`; a bare colour name also
matches product imagery such as "Acorn Aerosol Spray Paint", so without the
prefix there is no query that selects swatches and nothing else.

## Re-running

Safe to re-run. A colour whose swatch already exists in the workspace and is
published is reused rather than uploaded again, and its existing Content Key
flows into the mapping. Custom metadata records whose key already matches are
left alone, so a second run with nothing new to do deploys nothing.

Content left unpublished by an interrupted run is **adopted**: the run publishes
what is already there instead of creating it again. This matters because a
second create with the same external id fails with `DUPLICATE_VALUE`, so a
colour whose upload succeeded but whose publish did not would otherwise be stuck
failing on every future run.

Adoption is keyed on the external id this tool writes, so it only recovers
content this tool created. An unpublished swatch added by hand in the CMS UI
carries no external id, so it can be neither reused (it is not published) nor
adopted, and the create will collide on name uniqueness instead. Publish it or
delete it in the CMS UI and re-run.

Nothing is mapped until its publish has been confirmed by re-reading
`isPublished`. Publishing is a deployment, so a success response does not mean
the content is live, and a mapping row pointing at unpublished content would
render nothing for a shopper.

## Output

Two timestamped CSVs in `--out-dir`:

- `swatches-<org>-<timestamp>.csv` — one row per colour with the title, names,
  Content Key, what happened to the content (`uploaded`, `adopted`, `reused`,
  `skipped`, `failed`) and what happened to its metadata row (`written`,
  `unchanged`, `not-written`, `not-readable`, `key-mismatch`).
- `errors-<org>-<timestamp>.csv` — written only when something failed, with the
  phase and the error.

Rows the loader skips, and the delete that CMS does not support, are reported
without being treated as failures, so a clean run exits zero and writes no error
file.

Downloaded images are cached in `--cache-dir`, keyed by source URL, so a
re-run does not re-fetch them.

## Verification

Two checks are not optional, because both failures are silent otherwise:

**Uploaded bytes.** Salesforce returns `fileHash=<md5>` in the media URL of the
content it creates. Every upload compares that against the md5 of the bytes sent
and fails the row if they differ.

**Deployed metadata.** A deploy reporting success is not proof the rows are
readable, so after deploying the tool queries the records back and compares every
Content Key. The run exits non-zero if any record is missing or holds the wrong
key.

## Known limitation

CMS content cannot be deleted through the Connect API; unpublishing is the only
supported retirement. `--cleanup-test-upload` therefore unpublishes the legacy
test content, attempts a delete, and reports plainly when the platform refuses
it, leaving a manual removal in the CMS UI as the remaining step.
