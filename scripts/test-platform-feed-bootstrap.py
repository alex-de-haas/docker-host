import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("bootstrap", HERE / "platform-feed-bootstrap.py")
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)
HASH = "a" * 64


class BootstrapTests(unittest.TestCase):
    def test_embedded_unix_parser_is_exactly_the_tested_module(self):
        script = (HERE / "install.sh").read_text()
        embedded = script.split("<<'HOSTY_PLATFORM_BOOTSTRAP'\n", 1)[1].split("HOSTY_PLATFORM_BOOTSTRAP\n", 1)[0]
        self.assertEqual((HERE / "platform-feed-bootstrap.py").read_text(), embedded)

    def test_any_feed_count_and_case_sensitive_names(self):
        for count in (1, 3, 10):
            feeds = [dict(id=f"Publisher-{i}", releaseRef="https://example.test/release.json", releaseSha256=HASH, default=i == count - 1) for i in range(count)]
            index = dict(schemaVersion="hosty-platform-feeds.0.1", feeds=feeds)
            self.assertEqual(feeds[-1], bootstrap.select(index, ""))
            self.assertEqual(feeds[0], bootstrap.select(index, "Publisher-0"))
            with self.assertRaises(ValueError): bootstrap.select(index, "publisher-0")

    def test_ambiguous_defaults_and_duplicate_ids_fail(self):
        feed = dict(id="custom", releaseRef="https://example.test/release.json", releaseSha256=HASH)
        with self.assertRaises(ValueError): bootstrap.select(dict(schemaVersion="hosty-platform-feeds.0.1", feeds=[feed, feed]), "custom")
        with self.assertRaises(ValueError): bootstrap.select(dict(schemaVersion="hosty-platform-feeds.0.1", feeds=[feed, {**feed, "id": "second"}]), "")

    def test_incomplete_or_changed_pair_never_creates_a_receipt(self):
        feed = dict(id="custom", releaseRef="https://example.test/release.json", releaseSha256=HASH)
        index = dict(schemaVersion="hosty-platform-feeds.0.1", feeds=[feed])
        asset = dict(role="cli", rid="linux-x64", fileName="hosty", url="https://example.test/cli", size=10, sha256=HASH, inputFingerprint=HASH, provenance="build")
        release = dict(schemaVersion="hosty-platform-release.0.1", releaseId=HASH, sourceCommit="b" * 40, version="1.2.3", assets=[asset])
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(bootstrap, "document", side_effect=[(index, HASH), (release, HASH)]):
                with self.assertRaises(ValueError): bootstrap.main(["https://example.test/index", "", "linux-x64", directory])
            self.assertEqual([], list(Path(directory).iterdir()))
            release["assets"].append({**asset, "role": "core", "fileName": "hosty-core"})
            with patch.object(bootstrap, "document", side_effect=[(index, HASH), (release, "c" * 64)]):
                with self.assertRaises(ValueError): bootstrap.main(["https://example.test/index", "", "linux-x64", directory])
            self.assertEqual([], list(Path(directory).iterdir()))
            with patch.object(bootstrap, "document", side_effect=[(index, HASH), (release, HASH)]):
                bootstrap.main(["https://example.test/index", "", "linux-x64", directory])
            receipt = json.loads((Path(directory) / "release.json").read_text())
            self.assertEqual("custom", receipt["selection"]["source"]["feedId"])
            self.assertEqual(HASH, receipt["selection"]["release"]["releaseId"])


if __name__ == "__main__": unittest.main()
