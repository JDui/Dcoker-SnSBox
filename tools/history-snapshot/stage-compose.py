#!/usr/bin/env python3
"""Stage a prepared bundle into NEW local Docker volumes for UID 10001.

Inputs stay read-only. The source consistency declaration is preserved. No
database or key validation is performed; the existing reader owns that step.
"""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import uuid

from prepare import (REPO, PreparationError, absolute, fail, fingerprint, inventory,
                     overlaps, read_only, reject_links, select_profile, write_json)

UID = "10001:10001"
ROOT = "/run/snsbox-history"
SCRATCH = "/var/cache/snsbox-history"
INIT = """set -eu
umask 077
test -z "$(find /prepared -mindepth 1 -print -quit)"
test -z "$(find /scratch -mindepth 1 -print -quit)"
tar --no-same-owner -xpf - -C /prepared
find /prepared -type d -exec chmod 0700 {} +
find /prepared -type f -exec chmod 0600 {} +
chown -R 10001:10001 /prepared
chmod 0700 /scratch
chown 10001:10001 /scratch
"""
CHECK = """set -eu
test "$(id -u):$(id -g)" = 10001:10001
test -r /run/snsbox-history/history-sources.json
test -z "$(find /run/snsbox-history -type f ! -readable -print -quit)"
test "$(stat -c '%u:%g:%a' /run/snsbox-history)" = 10001:10001:700
if test "$HAS_KEYS" = 1; then
  test "$(stat -c '%u:%g:%a' /run/snsbox-history/secrets)" = 10001:10001:700
  test "$(stat -c '%u:%g:%a' /run/snsbox-history/secrets/history-wechat-keys.json)" = 10001:10001:600
fi
test "$(stat -c '%u:%g:%a' /var/cache/snsbox-history)" = 10001:10001:700
touch /var/cache/snsbox-history/.permission-check
rm /var/cache/snsbox-history/.permission-check
if touch /run/snsbox-history/.write-must-fail 2>/dev/null; then exit 1; fi
"""


class StageError(Exception):
    pass


def docker(*args: str) -> str:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, encoding="utf-8", timeout=60)
    if result.returncode:
        raise StageError("Docker operation failed; no private input or Docker error contents are printed.")
    return result.stdout.strip()


def require_local_engine(image: str):
    endpoint = os.environ.get("DOCKER_HOST")
    if not endpoint or os.environ.get("DOCKER_CONTEXT"):
        endpoint = json.loads(docker("context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"))
    if not isinstance(endpoint, str) or not endpoint.startswith(("unix:///", "npipe:////./pipe/", "npipe://./pipe/")):
        raise StageError("Only a local Unix socket or Windows named-pipe Docker context is accepted.")
    if not image or image.startswith("-"):
        raise StageError("Supply an existing local SnSBox image.")
    docker("image", "inspect", image, "--format", "{{.Id}}")


def guard(path: Path, active: list[Path]) -> Path:
    path = absolute(path)
    if any(overlaps(path, root) for root in active):
        fail("active_overlap")
    reject_links(path)
    path = path.resolve()
    if any(overlaps(path, root) for root in active):
        fail("active_overlap")
    if REPO is not None and overlaps(path, REPO / "data"):
        fail("data_overlap")
    return path


def small_json(path: Path):
    if fingerprint(path)[2] > 1024 * 1024:
        fail("limit")
    with read_only(path) as handle:
        return json.load(handle)


def bind_input(compose: dict, target: str, active: list[Path]) -> Path:
    matches = [mount for mount in compose["services"]["snsbox"]["volumes"]
               if mount.get("type") == "bind" and mount.get("target", "").replace("$$", "$") == target]
    if len(matches) != 1 or matches[0].get("read_only") is not True:
        raise StageError("Bundle must contain one read-only bind for each configured input.")
    return guard(Path(matches[0]["source"].replace("$$", "$")), active)


def archive_json(archive, name: str, value):
    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    info = tarfile.TarInfo(name)
    info.size, info.mode = len(data), 0o600
    archive.addfile(info, io.BytesIO(data))


def archive_file(archive, name: str, path: Path, expected: tuple):
    with read_only(path) as handle:
        value = os.fstat(handle.fileno())
        if (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns) != expected:
            fail("source_changed")
        info = tarfile.TarInfo(name)
        info.size, info.mode = expected[2], 0o600
        archive.addfile(info, handle)


def remove_owned_volumes(volumes: list[str], token: str):
    for name in reversed(volumes):
        try:
            label = docker("volume", "inspect", name, "--format", '{{index .Labels "snsbox.history-stage"}}')
            if label == token:
                docker("volume", "rm", name)
        except (StageError, OSError, subprocess.TimeoutExpired):
            pass


def stage(args) -> dict:
    active = [path for value in args.active_root for path in (absolute(value), absolute(value).resolve())]
    bundle, output = guard(Path(args.bundle), active), guard(Path(args.output), active)
    if output.exists():
        fail("output_exists")
    if overlaps(bundle, output):
        fail("data_overlap")
    if REPO is not None and REPO in output.parents and not (REPO / "private") in output.parents:
        fail("output_private")
    if (bundle / "INCOMPLETE.json").exists():
        raise StageError("The preparation bundle is incomplete; select a completed bundle.")
    entries = small_json(guard(bundle / "history-sources.json", active))
    compose = small_json(guard(bundle / "compose.history.yaml", active))
    if not isinstance(entries, list) or len(entries) != 1 or entries[0].get("platform") != "wechat":
        raise StageError("Select a single-source bundle created by prepare.py.")
    entry = dict(entries[0])
    profile = select_profile(bind_input(compose, entry["profilePath"], active))
    if not profile.name or profile.name in (".", "..") or any(value in profile.name for value in ("\0", "/", "\\")):
        raise StageError("The account directory name cannot be represented safely in the private volume.")
    manifest_input = bind_input(compose, "/run/config/history-sources.json", active)
    if manifest_input != bundle / "history-sources.json":
        raise StageError("The configured manifest does not belong to this preparation bundle.")
    if overlaps(profile, output):
        fail("data_overlap")
    files = inventory(profile)
    keys = bind_input(compose, entry["keysFile"], active) if entry.get("keysFile") else None
    key_meta = fingerprint(keys) if keys is not None else None
    if keys is not None and (overlaps(keys, output) or overlaps(keys, profile) or not 0 < key_meta[2] <= 1024 * 1024):
        fail("key_file")
    entry["profilePath"] = ROOT + "/profiles/" + profile.name
    if keys is not None:
        entry["keysFile"] = ROOT + "/secrets/history-wechat-keys.json"
    require_local_engine(args.image)
    token = uuid.uuid4().hex
    input_volume, scratch_volume = "snsbox-history-" + token + "-input", "snsbox-history-" + token + "-scratch"
    container = "snsbox-history-stage-" + token
    created = []
    output.mkdir(parents=True, mode=0o700)
    write_json(output / "INCOMPLETE.json", {"complete": False})
    try:
        for name in (input_volume, scratch_volume):
            # Never take over an existing volume, even if a name was reused.
            existing = docker("volume", "ls", "--filter", "name=^" + name + "$", "--format", "{{.Name}}")
            if existing:
                raise StageError("Refusing an existing staging volume.")
            docker("volume", "create", "--label", "snsbox.history-stage=" + token, name)
            created.append(name)
        command = ["docker", "run", "--rm", "--pull", "never", "--name", container, "--network", "none",
                   "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE",
                   "--security-opt", "no-new-privileges:true", "--mount", "type=volume,src=" + input_volume + ",dst=/prepared,volume-nocopy",
                   "--mount", "type=volume,src=" + scratch_volume + ",dst=/scratch,volume-nocopy", "--entrypoint", "/bin/sh", "-i", args.image, "-ec", INIT]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            with tarfile.open(fileobj=process.stdin, mode="w|") as archive:
                archive_json(archive, "history-sources.json", [entry])
                for name, expected in files.items():
                    if name.endswith((".db", ".db-wal")):
                        archive_file(archive, "profiles/" + profile.name + "/" + name, profile / name, expected)
                if keys is not None:
                    archive_file(archive, "secrets/history-wechat-keys.json", keys, key_meta)
            process.stdin.close()
            if process.wait(timeout=60):
                raise StageError("Private volume initialization failed; no deployment overlay was published.")
        finally:
            if not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
                try:
                    docker("rm", "--force", container)
                except StageError:
                    pass
        if inventory(profile) != files or keys is not None and fingerprint(keys) != key_meta:
            fail("source_changed")
        docker("run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", UID,
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--env", "HAS_KEYS=" + ("1" if keys is not None else "0"),
               "--mount", "type=volume,src=" + input_volume + ",dst=" + ROOT + ",readonly,volume-nocopy",
               "--mount", "type=volume,src=" + scratch_volume + ",dst=" + SCRATCH + ",volume-nocopy",
               "--entrypoint", "/bin/sh", args.image, "-ec", CHECK)
        deployment = {"services": {"snsbox": {"user": UID, "environment": {"SNSBOX_HISTORY_SOURCES_FILE": ROOT + "/history-sources.json", "TMPDIR": SCRATCH},
                      "volumes": [{"type": "volume", "source": "snsbox-history-input", "target": ROOT, "read_only": True, "volume": {"nocopy": True}},
                                  {"type": "volume", "source": "snsbox-history-scratch", "target": SCRATCH, "volume": {"nocopy": True}}]}},
                      "volumes": {"snsbox-history-input": {"external": True, "name": input_volume}, "snsbox-history-scratch": {"external": True, "name": scratch_volume}}}
        report = {"serviceUid": UID, "inputVolume": input_volume, "scratchVolume": scratch_volume,
                  "permissionCheckPassed": True, "sourceConsistencyPreserved": True,
                  "confirmedConsistentSnapshot": entry.get("confirmedConsistentSnapshot", False),
                  "readerValidation": "pending; no database decryption or real-history acceptance claimed"}
        write_json(output / "deployment.json", report)
        write_json(output / "compose.history.pending.json", deployment)
        (output / "INCOMPLETE.json").unlink()
        os.replace(output / "compose.history.pending.json", output / "compose.history.yaml")
        return report
    except BaseException:
        if not (output / "INCOMPLETE.json").exists():
            write_json(output / "INCOMPLETE.json", {"complete": False})
        remove_owned_volumes(created, token)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", help="Completed prepare.py bundle; never an active client directory")
    parser.add_argument("--output", required=True, help="New private deployment configuration directory")
    parser.add_argument("--active-root", action="append", required=True)
    parser.add_argument("--image", default="snsbox:0.1.0", help="Existing local SnSBox image; never pulled")
    args = parser.parse_args()
    try:
        stage(args)
        print(json.dumps({"ok": True, "serviceUid": UID, "permissionCheckPassed": True, "readerValidation": "pending"}))
        return 0
    except (PreparationError, StageError) as error:
        print(json.dumps({"ok": False, "message": str(error)}))
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        print(json.dumps({"ok": False, "message": "Could not stage the bundle; check local Docker access and free space. Private paths are suppressed."}))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
