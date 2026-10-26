import importlib.util
import pathlib
import unittest
from unittest.mock import patch
import io

spec = importlib.util.spec_from_file_location("feed", pathlib.Path(__file__).with_name("publish-update-feed.py"))
feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed)


def release(version, pre=False, digest=None, draft=False):
    return {"tag_name": "v" + version, "prerelease": pre, "draft": draft, "published_at": "2026-10-25T00:00:00Z",
            "assets": [{"name": "app.apk", "size": 12, "state": "uploaded", "digest": digest,
                        "browser_download_url": f"https://github.com/example/app/releases/download/v{version}/app.apk"}]}


class FeedTest(unittest.TestCase):
    def test_draft_exclusion_and_semantic_order(self):
        result = feed.build_feed("example/app", [release("1.0.0-rc.9", True), release("1.0.0"),
            release("2.0.0", draft=True), release("1.0.0-rc.10", True)], lambda *_: "a" * 64)
        self.assertEqual([r["version"] for r in result["releases"]], ["1.0.0", "1.0.0-rc.10", "1.0.0-rc.9"])

    def test_mislabeled_prerelease_is_not_stable(self):
        result = feed.build_feed("example/app", [release("1.0.0-rc.1")])
        self.assertTrue(result["releases"][0]["prerelease"])

    def test_missing_digest_hydrates_both_channels(self):
        calls = []
        releases = [release(f"2.0.0-rc.{i}", True) for i in range(150, 0, -1)] + [release("1.0.0")]
        result = feed.build_feed("example/app", releases, lambda u, s: calls.append(u) or "a" * 64)
        self.assertEqual(len(result["releases"]), 151)
        self.assertEqual(len(calls), 3)
        self.assertIsNotNone(result["releases"][-1]["assets"][0]["digest"])

    def test_valid_digest_does_not_redownload(self):
        result = feed.build_feed("example/app", [release("1.0.0", digest="sha256:" + "b" * 64)],
                                 lambda *_: self.fail("unexpected download"))
        self.assertEqual(result["releases"][0]["assets"][0]["digest"], "sha256:" + "b" * 64)

    def test_foreign_or_incomplete_asset_is_excluded(self):
        item = release("1.0.0")
        item["assets"][0]["browser_download_url"] = "https://github.com/other/app/releases/download/v1.0.0/app.apk"
        self.assertEqual(feed.build_feed("example/app", [item])["releases"][0]["assets"], [])
        self.assertFalse(feed.public_url("https://github.com@example.com/example/app/releases/download/v1.0.0/app.apk", "example/app", "v1.0.0"))

    def test_duplicate_tags_fail_closed(self):
        with self.assertRaises(ValueError):
            feed.build_feed("example/app", [release("1.0.0"), release("1.0.0")])

    def test_version_validation(self):
        for value in ("v01.0.0", "1.0.0-rc.01", "1.0", "1.0.0-a..b", "1.0.0+.", "1.0.0+a..b"):
            self.assertIsNone(feed.version_key(value))
        self.assertLess(feed.version_key("1.0.0-rc.9"), feed.version_key("1.0.0-rc.10"))
        self.assertLess(feed.version_key("1.0.0-rc.10"), feed.version_key("1.0.0"))

    def test_repository_endpoint_has_no_trailing_slash(self):
        with patch("urllib.request.urlopen", return_value=io.BytesIO(b'{"full_name":"example/app"}')) as request:
            self.assertEqual(feed.GitHub("example/app", "test-token").api("")["full_name"], "example/app")
        self.assertEqual(request.call_args.args[0].full_url, "https://api.github.com/repos/example/app")

    def test_oversized_publication_does_not_write_any_ref(self):
        github = feed.GitHub("example/app", "test-token")
        with patch.object(github, "api") as api, self.assertRaises(ValueError):
            github.publish({"body": "x" * feed.MAX_FEED_BYTES})
        api.assert_not_called()

    def test_publication_commits_before_fast_forward_and_never_forces(self):
        github = feed.GitHub("example/app", "test-token")
        with patch.object(github, "api", side_effect=[{"object": {"sha": "old"}}, {"tree": {"sha": "old-tree"}},
                {"tree": [{"path": "updates.json", "type": "blob"}]}, {"sha": "blob"}, {"sha": "tree"}, {"sha": "new"}, {}]) as api:
            github.publish({"releases": []})
        self.assertEqual(api.call_args_list[-1].args, ("git/refs/heads/updates", "PATCH", {"sha": "new", "force": False}))
        self.assertEqual(api.call_args_list[-2].args[2]["parents"], ["old"])

    def test_existing_unrelated_branch_is_not_overwritten(self):
        github = feed.GitHub("example/app", "test-token")
        with patch.object(github, "api", side_effect=[{"object": {"sha": "old"}}, {"tree": {"sha": "old-tree"}},
                {"tree": [{"path": "README.md", "type": "blob"}]}]) as api, self.assertRaises(ValueError):
            github.publish({"releases": []})
        self.assertTrue(all(call.args[1:] == () for call in api.call_args_list))

    def test_download_length_mismatch_is_rejected(self):
        with patch("urllib.request.urlopen", return_value=io.BytesIO(b"123")) as request:
            with self.assertRaises(ValueError):
                feed.GitHub.hash_asset("https://github.com/example/app/releases/download/v1.0.0/app.apk", 12)
        self.assertFalse(request.call_args.args[0].has_header("Authorization"))


if __name__ == "__main__":
    unittest.main()
