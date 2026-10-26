"""Pinned OPUS archive and atomically published, verified INT8 cache."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import urllib.request
import zipfile

SPEC = json.loads(Path(__file__).with_name('model.json').read_text())
MAX_EXTRACTED_BYTES = 2_000_000_000


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def valid_archive(path):
    return path.is_file() and path.stat().st_size == SPEC['archiveBytes'] and digest(path) == SPEC['archiveSha256']


def extract(archive, target):
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > 100 or sum(e.file_size for e in entries) > MAX_EXTRACTED_BYTES:
            raise ValueError('Model archive exceeds extraction limits')
        names = set()
        for entry in entries:
            path = Path(entry.filename)
            if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename
                    or not (target / path).resolve().is_relative_to(target.resolve())
                    or stat.S_ISLNK(entry.external_attr >> 16) or entry.filename in names):
                raise ValueError('Invalid model archive entry')
            names.add(entry.filename)
        source.extractall(target)


def valid_cache(folder):
    try:
        receipt = json.loads((folder / 'receipt.json').read_text())
        if receipt['archiveSha256'] != SPEC['archiveSha256'] or receipt['id'] != SPEC['id']:
            return False
        files = receipt['files']
        if not {'model/model.bin', 'model/config.json', 'source.spm', 'target.spm'} <= files.keys():
            return False
        for name, record in files.items():
            path = folder / name
            if not path.resolve().is_relative_to(folder.resolve()) or path.is_symlink():
                return False
            if not path.is_file() or path.stat().st_size != record['size'] or digest(path) != record['sha256']:
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def prepare(cache):
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / SPEC['id']
    if valid_cache(destination):
        print('OPUS phase: verified cache.', file=__import__('sys').stderr, flush=True)
        return destination
    archive = cache / 'opus-tc-big-2022-03-13.zip'
    if not valid_archive(archive):
        print('Downloading the pinned OPUS-MT Big model (889 MB).', file=__import__('sys').stderr, flush=True)
        fd, temporary = tempfile.mkstemp(prefix='opus-download-', dir=cache)
        try:
            total = 0
            with os.fdopen(fd, 'wb') as output, urllib.request.urlopen(SPEC['url'], timeout=120) as source:
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > SPEC['archiveBytes']:
                        raise ValueError('Model archive exceeds pinned size')
                    output.write(chunk)
            if not valid_archive(Path(temporary)):
                raise ValueError('Model archive checksum mismatch')
            os.replace(temporary, archive)
        finally:
            Path(temporary).unlink(missing_ok=True)
    import ctranslate2
    with tempfile.TemporaryDirectory(prefix='opus-prepare-', dir=cache) as temporary:
        stage = Path(temporary)
        original = stage / 'original'
        original.mkdir()
        extract(archive, original)
        output = stage / 'ready'
        output.mkdir()
        print('OPUS phase: converting INT8 weights.', file=__import__('sys').stderr, flush=True)
        ctranslate2.converters.OpusMTConverter(str(original)).convert(str(output / 'model'), quantization='int8')
        for name in ['source.spm', 'target.spm', 'LICENSE', 'README.md']:
            if (original / name).is_file():
                shutil.copyfile(original / name, output / name)
        files = {str(p.relative_to(output)).replace(os.sep, '/'):
                 {'size': p.stat().st_size, 'sha256': digest(p)} for p in output.rglob('*') if p.is_file()}
        (output / 'receipt.json').write_text(json.dumps({'id': SPEC['id'], 'archiveSha256': SPEC['archiveSha256'], 'files': files}))
        if not valid_cache(output):
            raise ValueError('Converted model cache is incomplete')
        # Only this app's known generation is replaced; incomplete staging is never a usable model.
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(output, destination)
    return destination
