# Rowboat Apps registry

The public index of published [Rowboat](https://github.com/rowboatlabs/rowboat) apps.

- `apps/<name>.json` — one record per published app, mapping the app name to its GitHub repo. Versions live entirely in GitHub Releases on that repo.
- `removed/<name>.json` — retired records (removed names stay retired).
- `schema/registry-record.schema.json` — the record schema enforced by CI.

## Publishing

Publish from inside Rowboat (Apps → Publish) — it opens the registry PR for you. Or add `apps/<name>.json` via fork + PR yourself; the `validate-and-merge` Action validates the record (name unique and valid, you own the referenced repo, the release carries the `.rowboat-app` bundle) and auto-merges on success.
