# Repository-hosted application updates

Each device reads `https://raw.githubusercontent.com/<owner>/<repository>/updates/updates.json` directly. The hub is not a prerequisite. Installers are downloaded from the selected release's immutable GitHub asset URL. No API token is distributed to clients.

## Feed contract

The document has `schemaVersion: 1`, canonical `repository`, ISO `generatedAt`, and `releases`. Release records retain GitHub field names: `tag_name`, `version`, `name`, `body`, `html_url`, `published_at`, `draft`, `prerelease`, and `assets`. Assets contain `name`, `size`, `browser_download_url`, `digest` (`sha256:<hex>`), and `state`; Android `versionCode` is optional. A missing checksum makes an installation asset ineligible. Assets such as Electron YAML and blockmaps remain available in the same record.

The feed publisher enumerates all release pages, excludes drafts and invalid versions, and treats a prerelease suffix as prerelease even if the GitHub flag is wrong. It preserves stable candidates when many prereleases exist. GitHub-provided digests are retained; missing installer digests on the two highest releases in each channel are computed from the actual public assets. Historical assets without a digest remain in the metadata but cannot be installed. Metadata is bounded to 4 MiB and published by one fast-forward update after successful generation, so a failure preserves the previous feed.

## Channel and upgrade rules

`stable` accepts only formal releases without prerelease suffixes. `preview` accepts both formal and prerelease versions. Channel preference is local and independent of hub login and installed package type. Existing preferences are migrated. Candidates must be strictly newer and have complete compatible assets. Switching channels cannot downgrade; an installed preview waits until stable catches up. Build metadata does not establish an upgrade. Jiran's historical `-rev.N` compatibility ordering remains a documented project exception.

Android requires an increasing package version code and matching package identity and signing lineage before installation. A published `versionCode`, when present, can reject unsuitable candidates before download; it is always checked against the downloaded APK. The system installer retains the final installation decision. Web/PWA caching and server deployments retain their own lifecycle.

## Request policy

Devices persist the response and ETag, normal check deadline (six hours with jitter), last manual attempt, failure count and retry deadline. Concurrent triggers share one request. Manual checks have a short cooldown and cannot bypass rate limiting. Respect `Retry-After` and rate reset headers; otherwise back off exponentially with a bound. Keep last good metadata separate from an error and do not report a failed check as 'up to date'. Downloads use independent clients, never hub credentials.

## Publication and bootstrap

`Repository update feed` runs after the release workflow succeeds, on published/edited/deleted release events, or via `workflow_dispatch`. The completed-workflow trigger also covers releases created using `GITHUB_TOKEN`, which do not themselves trigger ordinary release workflows. Only a trusted default-branch script executes with write permission. PRs execute offline contract tests only.

Run the workflow manually once after integration to initialize the dedicated `updates` branch from existing public releases. This only publishes metadata; it does not build installers, create a release, change a tag, or deploy the hub. An absent feed is reported as temporarily unavailable rather than triggering an API request storm. The feed is eventually consistent with GitHub's raw-content cache.

Release edits and withdrawals rebuild the index from the current published release set. Clients retain the strict upgrade guard even if the index moves backwards. Do not force-push or edit released asset URLs. A publisher failure is a failed update-publication operation and must be investigated before declaring that release discoverable.

Local verification: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p test_update_feed.py`. CI uses the same tests before publication. `--dry-run` validates real release metadata without writing the branch; it still accesses the authenticated API and may download recent assets for hashing.
