import hashlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import model


class ModelTests(unittest.TestCase):
    def test_archive_traversal_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ['../outside', '/outside', 'folder\\outside']:
                with zipfile.ZipFile(root / 'bad.zip', 'w') as z:
                    z.writestr(name, 'invalid')
                with self.assertRaises(ValueError):
                    model.extract(root / 'bad.zip', root / 'unpacked')
            with zipfile.ZipFile(root / 'bad.zip', 'w') as z:
                link = zipfile.ZipInfo('link')
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                z.writestr(link, '../outside')
            with self.assertRaises(ValueError):
                model.extract(root / 'bad.zip', root / 'unpacked')

    def test_cache_requires_all_files_and_detects_corruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertFalse(model.valid_cache(root))
            files = {}
            for name in ['model/model.bin', 'model/config.json', 'source.spm', 'target.spm']:
                p = root / name; p.parent.mkdir(exist_ok=True); p.write_bytes(b'original')
                files[name] = {'size': p.stat().st_size, 'sha256': model.digest(p)}
            (root / 'receipt.json').write_text(json.dumps({'id': model.SPEC['id'], 'archiveSha256': model.SPEC['archiveSha256'], 'files': files}))
            self.assertTrue(model.valid_cache(root))
            (root / 'source.spm').write_bytes(b'corrupt!')
            self.assertFalse(model.valid_cache(root))

    def test_oversized_or_wrong_hash_download_is_not_published(self):
        for content in [b'too long', b'bad']:
            with tempfile.TemporaryDirectory() as temporary, patch.dict(model.SPEC, {'archiveBytes': 3, 'archiveSha256': hashlib.sha256(b'yes').hexdigest()}), patch('urllib.request.urlopen', return_value=io.BytesIO(content)):
                with self.assertRaises(ValueError):
                    model.prepare(Path(temporary))
                self.assertEqual(list(Path(temporary).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
