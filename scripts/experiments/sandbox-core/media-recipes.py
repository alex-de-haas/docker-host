#!/usr/bin/env python3
"""Prepare local Media Server/Transcode Engine recipes for an isolated child Core.

Uses already available Docker images, creates fixture-only tags and writes copied
manifests/assets. Does not install/start apps, read credentials or mount media.
The output directory must be new and outside the repository. Keep the generated
image inventory for verification and remove only its alias tags after cleanup.
"""
import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--media-source', required=True, type=Path)
    parser.add_argument('--transcode-source', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    sources = (args.media_source.resolve(), args.transcode_source.resolve())
    output = args.output_dir.resolve()
    repository = Path(__file__).resolve().parents[3]
    if any(output.is_relative_to(root) for root in (repository, *sources)):
        parser.error('Output must be outside the repository and both source checkouts.')
    if output.exists():
        parser.error('Use a new output directory; existing evidence is not overwritten.')
    prepared = []
    inventory = []
    for source in sources:
        manifest = json.loads((source / 'manifest.json').read_text())
        for key in ('source', 'agent', 'catalogMetadata'):
            manifest.pop(key, None)
        manifest['runtimeProfiles'] = [{'key': 'docker', 'type': 'docker', 'default': True}]
        manifest['defaultRuntime'] = 'docker'
        for service in manifest['services']:
            runtime = service['runtimes']['docker']
            original = runtime['image']
            if not isinstance(original, dict) or not original.get('tag'):
                raise ValueError('Expected a repository/tag image object in the source manifest.')
            reference = original['repository'] + ':' + original['tag']
            image = json.loads(docker('image', 'inspect', reference))[0]
            image_id = image['Id']
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
                raise ValueError('Docker returned an invalid image ID.')
            # Preserve the repository: Core resolves its registry digest at first start.
            # A raw content ID is not a repository name in an ordinary app recipe.
            tag = 'hosty-qa-' + image_id.removeprefix('sha256:')
            alias = original['repository'] + ':' + tag
            runtime['image'] = {'repository': original['repository'], 'tag': tag}
            service['runtimes'] = {'docker': runtime}
            for port in runtime.get('ports', []):
                port.pop('hostPort', None)
                port.pop('localPort', None)
                if port.get('expose') == 'host':
                    port['expose'] = 'loopback'
            inventory.append({'appId': manifest['id'], 'service': service['key'],
                              'original': reference, 'fixtureTag': alias, 'imageId': image_id,
                              'repoDigests': image.get('RepoDigests', []),
                              'sourceRevision': (image.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision')})
        prepared.append((source, manifest))
    output.mkdir(parents=True, mode=0o700)
    for source, manifest in prepared:
        destination = output / manifest['id']
        destination.mkdir()
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        for nav in manifest.get('ui', {}).get('navigation', []):
            asset = nav.get('iconAsset')
            if not asset:
                continue
            path = (source / asset).resolve()
            if not path.is_relative_to(source) or Path(asset).is_absolute():
                raise ValueError('Navigation asset must remain inside the source checkout.')
            target = destination / asset
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    # Persist the complete cleanup inventory before the first Docker mutation.
    (output / 'images.json').write_text(json.dumps(inventory, indent=2) + '\n')
    for item in inventory:
        docker('tag', item['imageId'], item['fixtureTag'])
    print(f'Prepared {len(prepared)} recipes and {len(inventory)} fixture image tags in {output}')


if __name__ == '__main__':
    main()
