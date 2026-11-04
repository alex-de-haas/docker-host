#!/usr/bin/env python3
"""Resolve one immutable native release before the Unix installer replaces files.

This module is embedded verbatim in install.sh; it requires only Python's standard library.
"""
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.request
from urllib.parse import urlsplit
import uuid
import unicodedata


def require(condition, message):
    if not condition:
        raise ValueError(message)


def https(reference):
    require(isinstance(reference, str) and not any(ord(c) < 32 for c in reference), "Invalid release URL")
    uri = urlsplit(reference)
    require(uri.scheme == "https" and uri.hostname and not uri.username and not uri.password and not uri.fragment,
            "Release sources must use HTTPS without credentials or fragments")
    return reference


class SecureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        https(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def document(reference):
    with urllib.request.build_opener(SecureRedirect()).open(https(reference), timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
    require(0 < len(data) <= 1024 * 1024, "Release document is empty or too large")
    return json.loads(data), hashlib.sha256(data).hexdigest()


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def select(index, requested):
    require(index.get("schemaVersion") == "hosty-platform-feeds.0.1", "Unsupported feed index")
    feeds = index.get("feeds")
    require(isinstance(feeds, list) and feeds, "The index contains no feeds")
    ids = set()
    defaults = []
    for feed in feeds:
        name = feed.get("id")
        require(isinstance(name, str) and 0 < len(name) <= 128 and name == name.strip()
                and not any(unicodedata.category(c) == "Cc" for c in name) and name not in ids, "Invalid or duplicate feed ID")
        ids.add(name)
        https(feed.get("releaseRef"))
        require(valid_hash(feed.get("releaseSha256")), "Missing release descriptor hash")
        require(isinstance(feed.get("default", False), bool), "Invalid default flag")
        if feed.get("default"):
            defaults.append(feed)
    require(len(defaults) <= 1, "Multiple default feeds")
    if requested:
        chosen = next((feed for feed in feeds if feed["id"] == requested), None)
        require(chosen is not None, "The requested feed does not exist; no fallback was selected")
        return chosen
    require(len(feeds) == 1 or defaults, "Choose a feed explicitly; this index has no default")
    return feeds[0] if len(feeds) == 1 else defaults[0]


def validate_release(release, rid):
    require(release.get("schemaVersion") == "hosty-platform-release.0.1"
            and valid_hash(release.get("releaseId")), "Unsupported or invalid platform release")
    require(re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", release.get("sourceCommit", "")), "Missing qualified source revision")
    require(isinstance(release.get("version"), str) and release["version"], "Missing release version")
    assets = release.get("assets")
    require(isinstance(assets, list) and assets, "Empty release assets")
    identities = set()
    targets = set()
    for asset in assets:
        role, target, name = asset.get("role"), asset.get("rid"), asset.get("fileName")
        require(role in ("cli", "core") and isinstance(target, str) and re.fullmatch(r"[a-zA-Z0-9.-]{1,64}", target), "Invalid asset role/target")
        require(isinstance(name, str) and name not in ("", ".", "..") and not re.search(r"[/\\:\x00-\x1f\x7f]", name), "Unsafe asset filename")
        require((role, target) not in identities, "Duplicate asset role/target")
        identities.add((role, target)); targets.add(target)
        require(type(asset.get("size")) is int and asset["size"] > 0
                and valid_hash(asset.get("sha256")) and valid_hash(asset.get("inputFingerprint"))
                and isinstance(asset.get("provenance"), str) and asset["provenance"], "Incomplete asset identity")
        https(asset.get("url"))
    require(all(("cli", target) in identities and ("core", target) in identities for target in targets), "Incomplete CLI/Core pair")
    require(rid in targets, "This release does not support the current platform")
    return next(asset for asset in assets if asset["role"] == "cli" and asset["rid"] == rid)


def main(arguments):
    reference, requested, rid, destination = arguments
    index, index_hash = document(reference)
    feed = select(index, requested)
    release, release_hash = document(feed["releaseRef"])
    require(release_hash == feed["releaseSha256"], "Release descriptor SHA256 mismatch")
    asset = validate_release(release, rid)
    selection = dict(source=dict(schemaVersion="hosty-platform-update-source.0.1", indexRef=reference,
                                 feedId=feed["id"], revision=uuid.uuid4().hex), feed=feed, release=release,
                     indexSha256=index_hash, descriptorSha256=release_hash)
    receipt = dict(schemaVersion="hosty-platform-install.0.1", selection=selection, rid=rid,
                   installedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    target = Path(destination)
    (target / "release.json").write_text(json.dumps(receipt, separators=(",", ":")), encoding="utf-8")
    (target / "asset-url").write_text(asset["url"], encoding="utf-8")
    (target / "asset-sha").write_text(asset["sha256"], encoding="ascii")
    (target / "asset-size").write_text(str(asset["size"]), encoding="ascii")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError, TypeError, OSError) as error:
        sys.exit("hosty install: " + str(error))
