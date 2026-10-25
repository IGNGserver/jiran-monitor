#!/usr/bin/env python3
"""Publish public, cacheable release metadata; never run this in a client.

The updates branch contains only updates.json. Release assets remain immutable.
Only this CI publisher uses the authenticated GitHub API. No third-party modules.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

SCHEMA_VERSION = 1
MAX_FEED_BYTES = 4 * 1024 * 1024
VERSION = re.compile(r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
DIGEST = re.compile(r"^sha256:([0-9a-fA-F]{64})$")


def version_key(tag):
    match = VERSION.fullmatch(tag or "")
    if not match:
        return None
    if "+" in tag and any(not part for part in tag.split("+", 1)[1].split(".")):
        return None
    pre = match[4]
    identifiers = tuple((0, int(p)) if p.isdigit() else (1, p) for p in pre.split(".")) if pre else ()
    if pre and any(not p or (p.isdigit() and len(p) > 1 and p[0] == "0") for p in pre.split(".")):
        return None
    return (*map(int, match.group(1, 2, 3)), not bool(pre), identifiers)


def public_url(url, repository, tag):
    parsed = urllib.parse.urlsplit(url or "")
    prefix = f"/{repository}/releases/download/{urllib.parse.quote(tag, safe='')}/"
    # GitHub asset URLs may encode dots/plus differently. Compare decoded paths.
    return (parsed.scheme == "https" and parsed.netloc.lower() == "github.com"
            and not parsed.username and not parsed.query and not parsed.fragment
            and urllib.parse.unquote(parsed.path).startswith(urllib.parse.unquote(prefix)))


def installer(name):
    return name.lower().endswith((".apk", ".exe", ".deb", ".rpm", ".pkg", ".dmg", ".appimage", ".zip"))


def build_feed(repository, releases, hash_asset=None, now=None):
    """Normalize all published pages. Hydrate recent candidates, never drafts."""
    valid = [r for r in releases if not r.get("draft") and r.get("published_at")
             and version_key(r.get("tag_name")) is not None]
    valid.sort(key=lambda r: version_key(r["tag_name"]), reverse=True)
    # Include recent candidates from both channels even if the first API page is
    # exclusively prereleases. Older records with a GitHub digest are also usable.
    hydrate = set()
    for prerelease in (False, True):
        candidates = [r for r in valid if bool(r.get("prerelease") or VERSION.fullmatch(r["tag_name"])[4]) == prerelease]
        hydrate.update(r["tag_name"] for r in candidates[:2])
    result = []
    seen = set()
    for release in valid:
        tag = release["tag_name"]
        if tag in seen:
            raise ValueError(f"Duplicate release tag: {tag}")
        seen.add(tag)
        assets = []
        for source in release.get("assets", []):
            name = source.get("name", "")
            url = source.get("browser_download_url", "")
            size = source.get("size", 0)
            if (source.get("state", "uploaded") != "uploaded" or not name
                    or not isinstance(size, int) or size <= 0 or not public_url(url, repository, tag)):
                continue
            digest = source.get("digest") or ""
            if not DIGEST.fullmatch(digest) and installer(name) and tag in hydrate and hash_asset:
                digest = "sha256:" + hash_asset(url, size)
            if digest and not DIGEST.fullmatch(digest):
                raise ValueError(f"Invalid digest for {tag}/{name}")
            asset = {"name": name, "size": size, "browser_download_url": url,
                     "state": "uploaded", "digest": digest.lower() or None}
            code = source.get("versionCode")
            if isinstance(code, int) and 0 < code <= 2100000000:
                asset["versionCode"] = code
            assets.append(asset)
        result.append({"tag_name": tag, "version": tag.removeprefix("v"),
                       "name": release.get("name") or tag,
                       "body": (release.get("body") or "")[:16000],
                       "html_url": f"https://github.com/{repository}/releases/tag/{urllib.parse.quote(tag, safe='')}",
                       "published_at": release["published_at"], "draft": False,
                       "prerelease": bool(release.get("prerelease") or VERSION.fullmatch(tag)[4]),
                       "assets": assets})
    return {"schemaVersion": SCHEMA_VERSION, "repository": repository,
            "generatedAt": now or datetime.datetime.now(datetime.timezone.utc).isoformat(), "releases": result}


class GitHub:
    def __init__(self, repository, token):
        self.repository = repository
        self.token = token

    def api(self, path, method="GET", data=None):
        url = f"https://api.github.com/repos/{self.repository}" + (f"/{path}" if path else "")
        request = urllib.request.Request(url, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28",
                     "User-Agent": "repository-update-feed-publisher"})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    def releases(self):
        result = []
        # Explicit upper bound prevents an accidentally endless/incorrect pager.
        for page in range(1, 101):
            batch = self.api(f"releases?per_page=100&page={page}")
            if not isinstance(batch, list):
                raise ValueError("Invalid releases response")
            result.extend(batch)
            if len(batch) < 100:
                return result
        raise ValueError("Release pagination exceeded safety bound; feed was not changed")

    @staticmethod
    def hash_asset(url, expected_size):
        # Public download requests deliberately carry no API Authorization header.
        # urllib follows GitHub's signed CDN redirect without leaking credentials.
        request = urllib.request.Request(url, headers={"User-Agent": "repository-update-feed-publisher"})
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(request, timeout=120) as response:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > expected_size:
                    raise ValueError("Asset exceeds declared size")
                digest.update(chunk)
        if size != expected_size:
            raise ValueError("Asset length does not match release metadata")
        return digest.hexdigest()

    def publish(self, feed):
        content = json.dumps(feed, ensure_ascii=False, separators=(",", ":")).encode()
        if len(content) > MAX_FEED_BYTES:
            raise ValueError("Feed exceeds client size limit; existing feed was not changed")
        parent = None
        try:
            parent = self.api("git/ref/heads/updates")["object"]["sha"]
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        if parent:
            existing = self.api(f"git/commits/{parent}")
            entries = self.api(f"git/trees/{existing['tree']['sha']}")["tree"]
            if len(entries) != 1 or entries[0].get("path") != "updates.json" or entries[0].get("type") != "blob":
                raise ValueError("The updates branch contains unrelated files; refusing to replace it")
        # A dedicated orphan tree avoids publishing a source snapshot on updates.
        blob = self.api("git/blobs", "POST", {"content": base64.b64encode(content).decode(), "encoding": "base64"})
        tree = self.api("git/trees", "POST", {"tree": [{"path": "updates.json", "mode": "100644", "type": "blob", "sha": blob["sha"]}]})
        commit = self.api("git/commits", "POST", {"message": "chore: refresh published update feed",
                          "tree": tree["sha"], "parents": [parent] if parent else []})
        if parent:
            # Fast-forward only. A concurrent publisher fails instead of replacing
            # another publication; workflow concurrency serializes the normal path.
            self.api("git/refs/heads/updates", "PATCH", {"sha": commit["sha"], "force": False})
        else:
            self.api("git/refs", "POST", {"ref": "refs/heads/updates", "sha": commit["sha"]})
        print(f"Published {len(feed['releases'])} release records to {self.repository}/updates/updates.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Validate public metadata without writing a branch")
    args = parser.parse_args()
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not token:
        parser.error("GITHUB_REPOSITORY and GH_TOKEN/GITHUB_TOKEN are required")
    github = GitHub(repository, token)
    # Repository renames are resolved before constructing canonical asset URLs.
    repository = github.api("")["full_name"]
    github.repository = repository
    feed = build_feed(repository, github.releases(), github.hash_asset)
    size = len(json.dumps(feed, ensure_ascii=False, separators=(",", ":")).encode())
    if size > MAX_FEED_BYTES:
        raise ValueError("Feed exceeds client size limit; existing feed was not changed")
    if args.dry_run:
        print(f"Validated {len(feed['releases'])} release records ({size} bytes) for {repository}")
    else:
        github.publish(feed)


if __name__ == "__main__":
    main()
