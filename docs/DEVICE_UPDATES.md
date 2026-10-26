# Device updates

Desktop and Android read the repository-owned static index at
`https://raw.githubusercontent.com/IGNGserver/jiran-monitor/updates/updates.json`.
The index is published from complete GitHub Releases by the release workflow. A
release is installable only after its platform package and required metadata are
uploaded. The clients do not enumerate GitHub REST releases and do not use Hub
credentials for either checks or downloads.

Each device stores its own channel: `stable` accepts formal releases; `preview`
accepts formal releases and prereleases. Existing desktop `prerelease` settings
migrate to `preview`. A newer published formal release remains eligible on the
preview channel. Switching to stable while ahead waits for a strictly newer
stable release; it never installs an older package.

## Version compatibility

Project versions remain `MAJOR.MINOR.PATCH[-rev.N]`. Historical revisions sort
after the bare version because released APK versionCode and Debian package
versions already use that ordering. All application selection and installation
guards use that ordering. A desktop native-updater exception bridges SemVer's
opposite bare/revision order only for an already selected same-core revision
upgrade. Its feed is pinned to that tag, the returned version must equal the
selected version, and the exception is reset when the operation ends. Lower
versions never qualify. Existing revision builds can upgrade to a higher core
formal version.

## Request policy

Successful index bodies, ETags, the next background check, request attempts and
failure backoff are persisted locally. Automatic checks reuse a six-hour cache
with up to 30 minutes of jitter. Concurrent checks share work. Manual checks may
refresh a successful cache after 60 seconds, but cannot bypass a server cooldown.
Failures back off from one minute exponentially, capped at six hours; a longer
`Retry-After` or `X-RateLimit-Reset` always wins. A conditional 304 reuses and
revalidates the stored body. Invalid feeds and network failures do not replace
the last trusted body or pretend the application is up to date.

Desktop reads the channel selection once, then configures electron-updater with
the exact release's `releases/download/<tag>/latest*.yml`. SHA-512 metadata and
existing OS signing checks remain active. Windows requires its setup installer,
Linux its matching package type, and macOS its matching architecture ZIP.
Android uses an independent HTTP client, checks package SHA-256 and download
length, then verifies package identity, selected version, signing certificate and
strictly increasing Android versionCode before handing off to the system
installer. Its channel and update cache work without a Hub connection.

## Compatibility and validation

The Hub `/api/updates` endpoint remains available for old clients, with bounded
exponential and server-directed retry cooldown. New clients never call it.
Application update does not deploy or replace the Hub/Docker installation.

Node regression tests cover persisted 304 cache reuse, request coalescing,
manual cooldown, server cooldown after restart, invalid metadata, platform
eligibility, channel switching and historical revision comparisons. Android
`RepositoryUpdateFeedTest` covers the same selection and request contract using
MockWebServer. Existing download integrity, package and platform tests remain in
place. Real installer/signing handoff requires the corresponding signed release
on a supported device; a unit test or successful compilation does not prove it.