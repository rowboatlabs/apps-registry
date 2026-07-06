# Rowboat Apps Registry

The public registry for [Rowboat](https://github.com/rowboatlabs/rowboat) apps.

One JSON record per app maps a globally unique package name to the GitHub
repository that hosts it. That is all the registry stores — **versions never
touch this repo**. Each app version is a GitHub Release on the app's own
repository, carrying two assets:

- `<name>.rowboat-app` — the app bundle (ZIP)
- `rowboat-app.json` — a standalone copy of the manifest (powers quota-free
  catalog details and update checks)

## Layout

| Path | Purpose |
|---|---|
| `apps/<name>.json` | One record per published app |
| `removed/<name>.json` | Takedowns — the record moved here verbatim plus `removedAt` and `reason`; removed names stay retired |
| `schema/registry-record.schema.json` | JSON Schema enforced by the validation Action |
| `.github/workflows/validate-and-merge.yml` | Validates publish PRs and auto-merges them |

## Record format

`apps/<name>.json`:

```json
{
    "schemaVersion": 1,
    "name": "my-app",
    "owner": "octocat",
    "repo": "octocat/my-app",
    "description": "What the app does.",
    "iconUrl": "https://raw.githubusercontent.com/octocat/my-app/HEAD/dist/icon.png",
    "createdAt": "2026-07-06T00:00:00Z"
}
```

- `name` — 3–64 chars matching `^[a-z0-9]+(-[a-z0-9]+)*$`. Globally unique
  and immutable once published; the first publisher owns it. Forks must take
  a new name.
- `owner` — the publisher's GitHub login; must equal the PR author.
- `repo` — the public GitHub repository hosting the app's releases.
- `description` — optional, ≤ 500 chars, shown in the catalog.
- `iconUrl` — optional HTTPS icon URL for catalog listings.
- `createdAt` — ISO 8601 timestamp of first publication.

A record is written **once**, at first publish, and never modified.
Publishing a new version is just a new GitHub Release on the app repo — no
registry change.

## Publishing

Rowboat's guided publish does all of this for you. The manual path, for
developers bringing their own repo or build:

1. Host the app in a public GitHub repo you control. Create a release tagged
   `v<version>` (strict semver) and attach **both** assets:
   `<name>.rowboat-app` and `rowboat-app.json`.
2. Fork this repo and add exactly one file, `apps/<name>.json`, matching
   `schema/registry-record.schema.json`.
3. Open a PR against `main`. The validation Action either squash-merges it
   and comments `published: <name>`, or closes it with a comment whose first
   line is `rejected: <code>`.

**Monorepo constraint:** version discovery always reads the repo's *latest*
release (`releases/latest/download/…`). If one repo hosts several registered
apps, **every** release must attach **every** registered app's asset pair —
otherwise resolution for the other apps breaks whenever any one app
releases. One repo per app avoids this.

## Validation checks

A publish PR merges only if all of the following hold, checked in order; the
first failure closes the PR with the code shown:

1. The PR targets `main` — `invalid_base`
2. It adds exactly one new file under `apps/` and changes nothing else
   (records are add-only) — `invalid_diff`
3. The filename is `apps/<name>.json` with a valid package name —
   `invalid_filename`
4. The file is valid JSON, validates against the schema, and `record.name`
   equals the filename stem — `invalid_record`
5. `record.owner` equals the PR author — `owner_mismatch`
6. The name is not already registered — `name_taken` — and not retired —
   `name_retired`
7. `record.repo` exists and is public — `repo_not_found`, `repo_not_public` —
   and the PR author controls it (owns it, or authored its latest release) —
   `repo_not_owned`
8. `https://github.com/<repo>/releases/latest/download/<name>.rowboat-app`
   exists (existence probe only; bundles are not downloaded or inspected) —
   `release_asset_missing`

If every check passes but the merge itself fails (infrastructure hiccup),
the Action comments `error: merge_failed` and leaves the PR open for a
maintainer.

Two PRs racing for the same name serialize in a per-name concurrency group;
the loser fails the availability check.

## Moderation

- **Takedowns**: maintainers move `apps/<name>.json` to `removed/<name>.json`,
  adding `removedAt` and `reason`. Removed names stay retired.
- **Record corrections** (repo renames, transfers): the Action rejects
  modifications to existing records, so open an issue — corrections are
  maintainer-reviewed.
- To report an app, open an issue on this repo.
