"""Regression checks for recipe preparation; no Docker daemon is modified."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("media_recipes", Path(__file__).with_name("media-recipes.py"))
recipes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipes)


class RecipeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.sources = [self.root / "media", self.root / "engine"]
        for index, source in enumerate(self.sources):
            source.mkdir()
            (source / "icon.svg").write_text("<svg/>")
            (source / "manifest.json").write_text(json.dumps({"id": f"app-{index}", "services": [
                {"key": "api", "runtimes": {"docker": {"image": {"repository": "fixture", "tag": str(index)},
                    "ports": [{"containerPort": 8080, "localPort": 8080, "hostPort": 8080, "expose": "host"}]}}}],
                "ui": {"navigation": [{"iconAsset": "icon.svg"}]}}))
        self.output = self.root / "output"

    def run_helper(self, docker):
        with patch.object(recipes, "docker", side_effect=docker), patch("sys.argv", ["media-recipes.py",
            "--media-source", str(self.sources[0]), "--transcode-source", str(self.sources[1]), "--output-dir", str(self.output)]):
            recipes.main()

    def image(self, *args):
        if args[:2] == ("image", "inspect"):
            return json.dumps([{"Id": "sha256:" + "a" * 64}])
        self.assertTrue((self.output / "images.json").exists())
        return ""

    def test_rejects_source_output_and_symlink_alias(self):
        alias = self.root / "alias"
        alias.symlink_to(self.sources[0], target_is_directory=True)
        for output in (self.sources[0] / "evidence", alias / "evidence", Path(recipes.__file__).resolve().parent / "evidence"):
            self.output = output
            with self.assertRaises(SystemExit), patch.object(recipes, "docker") as docker:
                self.run_helper(docker)
            self.assertFalse(output.exists())

    def test_allocates_ports_and_records_inventory_before_tagging(self):
        self.run_helper(self.image)
        manifest = json.loads((self.output / "app-0" / "manifest.json").read_text())
        port = manifest["services"][0]["runtimes"]["docker"]["ports"][0]
        self.assertEqual({"containerPort": 8080, "expose": "loopback"}, port)

    def test_tag_failure_keeps_complete_cleanup_inventory(self):
        calls = []
        def docker(*args):
            if args[0] == "tag":
                calls.append(args)
                if len(calls) == 2:
                    raise RuntimeError("second tag failed")
            return self.image(*args)
        with self.assertRaises(RuntimeError):
            self.run_helper(docker)
        self.assertEqual(2, len(json.loads((self.output / "images.json").read_text())))

    def test_preparations_and_repeated_services_have_distinct_owned_aliases(self):
        aliases = []
        for name in ("first", "second"):
            self.output = self.root / name
            self.run_helper(self.image)
            aliases.extend(item["fixtureTag"] for item in json.loads((self.output / "images.json").read_text()))
        self.assertEqual(4, len(aliases))
        self.assertEqual(4, len(set(aliases)))

    def test_source_containment_does_not_allow_destination_traversal(self):
        manifest_path = self.sources[0] / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["ui"]["navigation"][0]["iconAsset"] = "../media/icon.svg"
        manifest_path.write_text(json.dumps(manifest))
        calls = []
        def docker(*args):
            calls.append(args)
            return self.image(*args)
        with self.assertRaisesRegex(ValueError, "recipe destination"):
            self.run_helper(docker)
        self.assertFalse((self.output / "media").exists())
        self.assertFalse(any(args[0] == "tag" for args in calls))

    def test_app_id_cannot_escape_output_or_reuse_output_root(self):
        manifest_path = self.sources[0] / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        outside = self.root / "outside"
        for index, app_id in enumerate(("../outside", str(outside), ".")):
            self.output = self.root / f"output-{index}"
            manifest["id"] = app_id
            manifest_path.write_text(json.dumps(manifest))
            calls = []
            def docker(*args):
                calls.append(args)
                return self.image(*args)
            with self.assertRaisesRegex(ValueError, "recipe directory"):
                self.run_helper(docker)
            self.assertFalse(outside.exists())
            self.assertFalse(any(args[0] == "tag" for args in calls))
            self.assertFalse((self.output / "manifest.json").exists())

    def test_missing_asset_creates_no_aliases(self):
        (self.sources[1] / "icon.svg").unlink()
        calls = []
        def docker(*args):
            calls.append(args)
            return self.image(*args)
        with self.assertRaises(FileNotFoundError):
            self.run_helper(docker)
        self.assertFalse(any(args[0] == "tag" for args in calls))


if __name__ == "__main__":
    unittest.main()
