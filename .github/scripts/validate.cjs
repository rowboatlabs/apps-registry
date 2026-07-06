// Validation logic for registry publish PRs (APPS_SPEC.md §9.3).
// Invoked by .github/workflows/validate-and-merge.yml via actions/github-script,
// so it always runs from the base branch — a PR cannot change the rules that
// judge it.
//
// SECURITY: this runs under pull_request_target with write permissions on the
// registry repo. PR content must only ever be treated as data — never checked
// out, never executed.

'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MIN = 3;
const NAME_MAX = 64;
const MAX_RECORD_BYTES = 10 * 1024;
const MERGE_ATTEMPTS = 3;
const MERGE_RETRY_MS = 4000;

module.exports = async ({ github, context, core }) => {
    const prNumber = context.payload.pull_request.number;
    const { owner, repo } = context.repo;

    // Re-fetch: the per-name concurrency group may have held this run while
    // another PR for the same name went first.
    const pr = (await github.rest.pulls.get({ owner, repo, pull_number: prNumber })).data;
    if (pr.state !== 'open') {
        core.info(`PR #${prNumber} is no longer open; nothing to do.`);
        return;
    }
    const author = pr.user.login;

    const comment = (body) =>
        github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });

    // Machine-readable first line (`rejected: <code>`) — the Rowboat client
    // parses it. Close after commenting.
    const reject = async (code, detail) => {
        await comment(`rejected: ${code}\n\n${detail}`);
        await github.rest.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
        core.setFailed(`rejected: ${code} — ${detail}`);
    };

    const files = await github.paginate(github.rest.pulls.listFiles, {
        owner, repo, pull_number: prNumber, per_page: 100,
    });

    // Maintenance guard: registry maintainers open PRs that are not publish
    // records (workflow changes, record corrections, takedowns — §9.3
    // "maintainer-reviewed"). Those must not be auto-closed; leave them for
    // human review. Publish-shaped PRs from maintainers still flow through
    // the normal pipeline below.
    const publishShaped = files.length === 1
        && files[0].status === 'added'
        && /^apps\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(files[0].filename);
    const isMaintainer = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association);
    if (!publishShaped && isMaintainer) {
        const marker = 'skipped: not_a_publish_pr';
        const comments = await github.paginate(github.rest.issues.listComments, {
            owner, repo, issue_number: prNumber, per_page: 100,
        });
        if (!comments.some((c) => c.body && c.body.startsWith(marker))) {
            await comment(`${marker}\n\nThis PR is not shaped like a publish record (one added \`apps/<name>.json\`) and its author has write access — leaving it open for human review.`);
        }
        core.info('Maintenance PR from a maintainer; skipping validation.');
        return;
    }

    // Check 0 — the PR targets the default branch (the merge below merges
    // into the PR's base, so validating against main only makes sense there).
    if (pr.base.ref !== pr.base.repo.default_branch) {
        return reject('invalid_base',
            `Publish PRs must target \`${pr.base.repo.default_branch}\` (this PR targets \`${pr.base.ref}\`).`);
    }

    // Check 1 — the diff adds exactly one file, under apps/, nothing else.
    if (files.length !== 1) {
        return reject('invalid_diff',
            `The PR must add exactly one file under \`apps/\` and change nothing else (this PR changes ${files.length} files).`);
    }
    const file = files[0];
    if (file.status !== 'added') {
        return reject('invalid_diff',
            `Registry records are add-only (\`${file.filename}\` has status \`${file.status}\`). ` +
            'Corrections to existing records are maintainer-reviewed — open an issue instead.');
    }

    // Check 2 — filename is apps/<name>.json with a valid package name.
    const m = file.filename.match(/^apps\/([^/]+)\.json$/);
    if (!m) {
        return reject('invalid_filename',
            `The added file must be \`apps/<name>.json\` (got \`${file.filename}\`).`);
    }
    const name = m[1];
    if (!PACKAGE_NAME_RE.test(name) || name.length < NAME_MIN || name.length > NAME_MAX) {
        return reject('invalid_filename',
            `\`${name}\` is not a valid package name (lowercase letters/digits with single hyphens, ${NAME_MIN}–${NAME_MAX} chars).`);
    }

    // Read the record from the PR head. Content is data only.
    if (!pr.head.repo) {
        return reject('invalid_record',
            'The PR head repository is unavailable (deleted fork?); push the branch to an accessible repo and open a new PR.');
    }
    let raw;
    try {
        const res = await github.rest.repos.getContent({
            owner: pr.head.repo.owner.login,
            repo: pr.head.repo.name,
            path: file.filename,
            ref: pr.head.sha,
        });
        raw = Buffer.from(res.data.content, 'base64');
    } catch (e) {
        return reject('invalid_record',
            `Could not read \`${file.filename}\` from the PR head: ${e.message}`);
    }
    if (raw.length > MAX_RECORD_BYTES) {
        return reject('invalid_record', `The record file exceeds ${MAX_RECORD_BYTES} bytes.`);
    }
    let record;
    try {
        record = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        return reject('invalid_record', `\`${file.filename}\` is not valid JSON: ${e.message}`);
    }

    // Check 3 — schema validation; record.name equals the filename stem.
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const schemaPath = path.join(process.env.GITHUB_WORKSPACE || '.', 'schema', 'registry-record.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    if (!ajv.validate(schema, record)) {
        return reject('invalid_record',
            'Schema validation failed (`schema/registry-record.schema.json`):\n```\n' +
            ajv.errorsText(ajv.errors, { separator: '\n' }) + '\n```');
    }
    if (record.name !== name) {
        return reject('invalid_record',
            `\`record.name\` (\`${record.name}\`) must equal the filename stem (\`${name}\`).`);
    }

    // Check 4 — record.owner equals the PR author.
    if (record.owner.toLowerCase() !== author.toLowerCase()) {
        return reject('owner_mismatch',
            `\`record.owner\` (\`${record.owner}\`) must equal the PR author (\`${author}\`).`);
    }

    // Check 5 — the name is neither registered nor retired. This runs inside
    // the per-name concurrency group, so it is the authoritative collision
    // guard: of two racing PRs, the loser fails here.
    const existsOnMain = async (p) => {
        try {
            await github.rest.repos.getContent({ owner, repo, path: p, ref: pr.base.ref });
            return true;
        } catch (e) {
            if (e.status === 404) return false;
            throw e;
        }
    };
    if (await existsOnMain(`apps/${name}.json`)) {
        return reject('name_taken',
            `\`${name}\` is already registered. Names are first-come, immutable identity — pick a new name.`);
    }
    if (await existsOnMain(`removed/${name}.json`)) {
        return reject('name_retired',
            `\`${name}\` was removed from the registry and stays retired — pick a new name.`);
    }

    // Check 6 — record.repo exists, is public, and the PR author controls it.
    // The collaborator-permission endpoint is unusable here (it requires the
    // caller to have push access on the target repo, which this workflow's
    // token never has for third-party repos), so control is proven publicly:
    // the author owns the repo, or authored its latest release (creating a
    // release requires push access).
    const [appRepoOwner, appRepoName] = record.repo.split('/');
    let appRepo;
    try {
        appRepo = (await github.rest.repos.get({ owner: appRepoOwner, repo: appRepoName })).data;
    } catch (e) {
        if (e.status === 404) {
            return reject('repo_not_found', `\`${record.repo}\` does not exist or is not public.`);
        }
        throw e;
    }
    if (appRepo.private) {
        return reject('repo_not_public', `\`${record.repo}\` must be a public repository.`);
    }
    let controlsRepo = appRepo.owner.login.toLowerCase() === author.toLowerCase();
    if (!controlsRepo) {
        try {
            const release = (await github.rest.repos.getLatestRelease({
                owner: appRepoOwner, repo: appRepoName,
            })).data;
            controlsRepo = !!release.author
                && release.author.login.toLowerCase() === author.toLowerCase();
        } catch (e) {
            if (e.status !== 404) throw e;
        }
    }
    if (!controlsRepo) {
        return reject('repo_not_owned',
            `The PR author (\`${author}\`) must control \`${record.repo}\`: own it, or be the author of its latest release.`);
    }

    // Check 7 — the latest release serves the bundle asset. Existence probe
    // only; no download, no structural validation (D14).
    const assetUrl = `https://github.com/${record.repo}/releases/latest/download/${name}.rowboat-app`;
    let probeStatus;
    try {
        probeStatus = (await fetch(assetUrl, { method: 'HEAD', redirect: 'manual' })).status;
    } catch (e) {
        return reject('release_asset_missing', `Probing \`${assetUrl}\` failed: ${e.message}`);
    }
    if (probeStatus !== 200 && probeStatus !== 302) {
        return reject('release_asset_missing',
            `\`${assetUrl}\` answered ${probeStatus}. The latest release on \`${record.repo}\` must attach ` +
            `\`${name}.rowboat-app\` (and \`rowboat-app.json\`).`);
    }

    // All checks passed — squash-merge, then comment `published: <name>`.
    // Retry the merge a few times: GitHub may not have computed mergeability
    // yet right after the checks.
    let merged = false;
    let lastError;
    for (let attempt = 0; attempt < MERGE_ATTEMPTS && !merged; attempt++) {
        try {
            await github.rest.pulls.merge({
                owner, repo, pull_number: prNumber,
                merge_method: 'squash',
                commit_title: `publish: ${name} (#${prNumber})`,
            });
            merged = true;
        } catch (e) {
            lastError = e;
            await new Promise((r) => setTimeout(r, MERGE_RETRY_MS));
        }
    }
    if (!merged) {
        // Infra failure, not a failed check: leave the PR open (the client
        // treats it as pending) and let a maintainer look.
        await comment(`error: merge_failed\n\nAll checks passed but the merge failed: ${lastError.message}\n\nLeaving the PR open for a maintainer.`);
        core.setFailed(`merge_failed: ${lastError.message}`);
        return;
    }
    await comment(`published: ${name}`);
    core.info(`published: ${name}`);
};
