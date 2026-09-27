#!/usr/bin/env python3
"""Local-only PostgreSQL and application-file recovery points (no cloud clients)."""

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time


PROJECT = Path(__file__).resolve().parents[2]
ROOT = Path(os.environ.get("OPENPBL_LOCAL_BACKUP_DIR", str(PROJECT / ".openpbl-data/local-backup"))).resolve()
CONTAINER = os.environ.get("OPENPBL_BACKUP_POSTGRES_CONTAINER", "openpbl-postgres-1")
PORT = os.environ.get("OPENPBL_BACKUP_POSTGRES_PORT", "15432")
DATABASE = os.environ.get("OPENPBL_BACKUP_DATABASE", "openpbl")
DB_USER = os.environ.get("OPENPBL_BACKUP_DATABASE_USER", "openpbl")
REPLICATION_USER = "openpbl_local_backup"
SLOT = "openpbl_local_backup"
WAL_CONTAINER = "openpbl-local-wal"
RETENTION_DAYS = 30
RECOVERY_SETTINGS = ("max_connections", "max_worker_processes", "max_wal_senders",
                     "max_prepared_transactions", "max_locks_per_transaction")
# Authored build inputs only. Runtime data/configuration have separate, private
# snapshots; Git's credential/config directory and generated dependencies never
# enter the source tree, even if someone accidentally adds them to the index.
SOURCE_DIRECTORIES = frozenset(("src", "packages", "scripts", "prisma", "public", "patches",
                                "deploy", "config", "tools", "img", "tests"))
SOURCE_ROOT_FILES = frozenset(("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "next.config.ts",
    "tsconfig.json", "tsconfig.check.json", "postcss.config.mjs", "components.json", "eslint.config.mjs",
    "vitest.config.mts", "vitest.setup.ts", "playwright.config.ts", "Dockerfile", ".dockerignore",
    ".gitignore", ".env.example", "server-providers.example.yml", "docker-compose.yml",
    "docker-compose.prod.yml", "docker-compose.ip.yml"))
SOURCE_EXCLUDED_PARTS = frozenset(("node_modules", ".git", ".ssh", ".aws", ".openpbl-data", ".openpbl-runtime",
    "secrets", "credentials", "dist", "coverage", "__pycache__", ".cache", ".pnpm-store",
    "test-results", "playwright-report", "backups", "pgdata"))
SOURCE_EXCLUDED_PREFIXES = ("deploy/reports/", "tests/load/reports/", "tests/load/results/",
                            "public/vendor/maic-importer/", "public/vendor/pdfjs/")
SOURCE_REQUIRED_FILES = frozenset(("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "next.config.ts",
    "tsconfig.json", "postcss.config.mjs", "prisma/schema.prisma", "prisma/migrations/migration_lock.toml",
    "scripts/build-document-converter-worker.mjs", "scripts/run-next-production.mjs", "scripts/run-prisma.mjs",
    "scripts/check-generated-css.mjs", "scripts/check-runtime-build-isolation.mjs", "scripts/sync-maic-importer.mjs",
    "scripts/openpbl-production-service.sh", "deploy/backup/local-backup.py", "src/instrumentation-node.ts",
    "src/lib/project-practice/document-conversion-worker.ts", "src/lib/project-practice/document-conversion-engine.ts",
    "src/lib/project-practice/document-conversion-pool.ts", "src/lib/project-practice/document-conversion-queue.ts",
    "src/lib/project-practice/document-archive.ts", "packages/mathml2omml/package.json", "packages/pptxgenjs/package.json",
    "packages/@openmaic/dsl/package.json", "packages/@openmaic/generation/package.json",
    "packages/@openmaic/importer/package.json", "packages/@openmaic/renderer/package.json"))


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, **kwargs)


def output(args):
    return run(args, capture_output=True).stdout.strip()


def image():
    # Pin to the exact local image ID used by the database, including extensions.
    return output(["docker", "inspect", "--format", "{{.Image}}", CONTAINER])


def pg_args(container=CONTAINER):
    return ["docker", "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
            "-p", PORT, "-U", DB_USER, "-d", DATABASE]


def sql(statement, container=CONTAINER):
    return run(pg_args(container), input=statement, capture_output=True, timeout=20).stdout.strip()


def client(command, *args):
    return ["docker", "run", "--rm", "--network=host", "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", f"{ROOT}:{ROOT}", "--entrypoint", command, image(), *map(str, args)]


def initialize_dirs():
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    ROOT.chmod(0o700)
    for name in ("bases", "wal", "snapshots", "status", "drills"):
        (ROOT / name).mkdir(exist_ok=True, mode=0o700)


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def stamp():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


@contextlib.contextmanager
def lock():
    initialize_dirs()
    with (ROOT / "status/backup.lock").open("w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def setup():
    initialize_dirs()
    sql("""DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='openpbl_local_backup') THEN
          CREATE ROLE openpbl_local_backup LOGIN REPLICATION;
        END IF;
      END $$;
      SELECT pg_create_physical_replication_slot('openpbl_local_backup', true)
      WHERE NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name='openpbl_local_backup');
    """)
    # SIGHUP setting; bounds retained WAL if the receiver is unavailable. A lost
    # slot requires a new base; health must fail rather than hide the WAL gap.
    sql("ALTER SYSTEM SET max_slot_wal_keep_size='4GB';")
    sql("SELECT pg_reload_conf();")
    print("Local replication role and bounded WAL slot configured; no database restart.")


def receive_wal():
    initialize_dirs()
    args = client("pg_receivewal", "-h", "127.0.0.1", "-p", PORT, "-U", REPLICATION_USER,
                  "--directory", ROOT / "wal", "--slot", SLOT, "--synchronous", "--status-interval=5")
    args[3:3] = ["--name", WAL_CONTAINER, "--label", "openpbl.local-backup=wal"]
    os.execvp(args[0], args)


def bases():
    return sorted(path for path in (ROOT / "bases").iterdir()
                  if path.is_dir() and (path / "complete.json").is_file())


def snapshots():
    return sorted(path for path in (ROOT / "snapshots").iterdir()
                  if path.is_dir() and (path / "manifest.json").is_file())


def take_base():
    available = bases()
    if available:
        completed = json.loads((available[-1] / "complete.json").read_text())
        if time.time() - completed["completedEpoch"] < 86400:
            if "recoverySettings" not in completed:
                completed["recoverySettings"] = recovery_settings()
                write_json(available[-1] / "complete.json", completed)
            return available[-1]
    target = ROOT / "bases" / stamp()
    target.mkdir()
    run(client("pg_basebackup", "-h", "127.0.0.1", "-p", PORT, "-U", REPLICATION_USER,
               "-D", target / "data", "--wal-method=stream", "--checkpoint=spread", "--manifest-checksums=SHA256"))
    run(client("/usr/lib/postgresql/16/bin/pg_verifybackup", target / "data"), capture_output=True)
    manifest = json.loads((target / "data/backup_manifest").read_text())
    wal_range = manifest["WAL-Ranges"][0]
    first_wal = sql(f"SELECT pg_walfile_name('{wal_range['Start-LSN']}')")
    write_json(target / "complete.json", {"completedEpoch": time.time(), "image": image(),
                "firstWal": first_wal, "recoverySettings": recovery_settings()})
    print(f"Verified PostgreSQL base: {target.name}", flush=True)
    return target


def table_fingerprint_sql(table):
    quoted = '"' + table.replace('"', '""') + '"'
    # Hash canonical jsonb per row, then a sorted sequence of those hashes.
    # Report contains no raw student, credential or conversation content.
    return ("SELECT json_build_object('count', count(*), 'digest', "
            "md5(coalesce(string_agg(h, '' ORDER BY h), ''))) "
            f"FROM (SELECT md5(to_jsonb(t)::text) h FROM public.{quoted} t) rows;")


def recovery_settings():
    names = ",".join("'" + name + "'" for name in RECOVERY_SETTINGS)
    return json.loads(sql(f"SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN ({names})"))


def dump_consistent(target):
    process = subprocess.Popen(pg_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1)

    def query(statement):
        process.stdin.write(statement + "\n")
        process.stdin.flush()
        result = process.stdout.readline().strip()
        if not result:
            raise RuntimeError("Snapshot database transaction failed")
        return result

    try:
        snapshot_id = query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();")
        tables = json.loads(query("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public';"))
        records = {table: json.loads(query(table_fingerprint_sql(table))) for table in tables}
        assets = json.loads(query('SELECT coalesce(json_agg(json_build_object(\'id\', id, \'storageKey\', "storageKey", \'sha256\', sha256)), \'[]\'::json) FROM "FileAsset" WHERE "deletedAt" IS NULL;'))
        run(client("pg_dump", "-h", "127.0.0.1", "-p", PORT, "-U", DB_USER, "-d", DATABASE,
                   "--snapshot", snapshot_id, "--lock-wait-timeout=30s", "--format=directory", "--jobs=2", "--file", target / "database"))
        process.stdin.write("ROLLBACK;\n\\q\n")
        process.stdin.flush()
        process.wait(timeout=10)
        if process.returncode:
            raise RuntimeError("Snapshot database transaction did not close cleanly")
        return records, assets
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate()


def sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def source_path_allowed(relative):
    parts = relative.split("/")
    if not relative or any(part in ("", ".", "..") for part in parts) or "\\" in relative:
        return False
    if parts[0] not in SOURCE_DIRECTORIES and relative not in SOURCE_ROOT_FILES:
        return False
    if any(part in SOURCE_EXCLUDED_PARTS or part.startswith(".next") for part in parts):
        return False
    # "artifacts"/"reports" can also name authored application API directories.
    # Exclude known output locations, never every occurrence of those words.
    if relative.startswith(SOURCE_EXCLUDED_PREFIXES):
        return False
    name = parts[-1].lower()
    if name.startswith(".env") and relative != ".env.example":
        return False
    if name in (".deploy.env", ".npmrc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519"):
        return False
    return not name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm",
                              ".db", ".db-wal", ".db-shm", ".dump", ".rdb", ".wal",
                              ".pem", ".key", ".p12", ".pfx", ".log", ".cpuprofile", ".heapprofile", ".heapsnapshot", ".tsbuildinfo"))


def source_candidates():
    # NUL delimiters preserve spaces/newlines. Read the working-tree bytes, not
    # git show/HEAD: uncommitted edits and new, nonignored files are recoverable.
    value = run(["git", "-C", PROJECT, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                capture_output=True).stdout
    return sorted({path for path in value.split("\0") if source_path_allowed(path)
                   and (PROJECT / path).exists()})


def check_source_inputs(root, files):
    missing = SOURCE_REQUIRED_FILES - files.keys()
    if missing:
        raise RuntimeError("Source snapshot missing build inputs: " + ", ".join(sorted(missing)))
    if not any(name.startswith("prisma/migrations/") and name.endswith("/migration.sql") for name in files):
        raise RuntimeError("Source snapshot has no database migrations")
    package = json.loads((root / "package.json").read_text())
    if "scripts/build-document-converter-worker.mjs" not in package.get("scripts", {}).get("build", ""):
        raise RuntimeError("Source snapshot build does not generate the DOCX worker")
    for patch_file in package.get("pnpm", {}).get("patchedDependencies", {}).values():
        if not isinstance(patch_file, str) or patch_file not in files or not source_path_allowed(patch_file):
            raise RuntimeError("Source snapshot is missing a pinned dependency patch")


def source_tree_digest(files):
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def snapshot_source(target):
    destination = target / "source"
    destination.mkdir(mode=0o700)
    paths = source_candidates()
    head = output(["git", "-C", PROJECT, "rev-parse", "HEAD"])
    files = {}
    for relative in paths:
        source = PROJECT / relative
        # Never dereference a symlink into secrets, dependencies or runtime data.
        if source.is_symlink() or any(parent.is_symlink() for parent in source.parents if parent != PROJECT.parent):
            raise RuntimeError("Source snapshot refuses symlink: " + relative)
        before = source.stat()
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError("Source snapshot requires regular files: " + relative)
        copied = destination / relative
        copied.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, copied)
        digest = sha256(copied)
        after = source.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise RuntimeError("Source changed during snapshot: " + relative)
        files[relative] = {"sha256": digest, "size": copied.stat().st_size, "mode": stat.S_IMODE(copied.stat().st_mode)}
    check_source_inputs(destination, files)
    # Detect edits/additions/deletions during the copy; acknowledge no mixed
    # build input set. This is not a Git commit or an atomic filesystem snapshot.
    if paths != source_candidates() or head != output(["git", "-C", PROJECT, "rev-parse", "HEAD"]):
        raise RuntimeError("Source tree changed during snapshot")
    for relative, expected in files.items():
        source = PROJECT / relative
        if source.is_symlink() or sha256(source) != expected["sha256"] or stat.S_IMODE(source.stat().st_mode) != expected["mode"]:
            raise RuntimeError("Source changed during snapshot: " + relative)
    dirty = bool(output(["git", "-C", PROJECT, "status", "--porcelain=v1", "--untracked-files=all"]))
    manifest = {"format": 1, "kind": "working-tree", "gitHead": head, "gitDirty": dirty,
                "treeSha256": source_tree_digest(files), "files": files}
    write_json(target / "source-manifest.json", manifest)
    return {"format": 1, "manifestSha256": sha256(target / "source-manifest.json"),
            "treeSha256": manifest["treeSha256"], "files": len(files), "gitHead": head, "gitDirty": dirty}


def verify_source(snapshot, expected):
    manifest_path = snapshot / "source-manifest.json"
    if manifest_path.is_symlink() or sha256(manifest_path) != expected["manifestSha256"]:
        raise RuntimeError("Source manifest checksum mismatch")
    manifest = json.loads(manifest_path.read_text())
    files = manifest["files"]
    if manifest.get("format") != 1 or manifest.get("kind") != "working-tree" or len(files) != expected["files"] \
            or manifest.get("gitHead") != expected["gitHead"] or manifest.get("gitDirty") != expected["gitDirty"] \
            or manifest.get("treeSha256") != source_tree_digest(files) or manifest["treeSha256"] != expected["treeSha256"]:
        raise RuntimeError("Source tree manifest mismatch")
    root = snapshot / "source"
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("Restored source must be a real directory")
    actual = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Restored source contains a symlink")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    if actual != set(files):
        raise RuntimeError("Source tree file inventory mismatch")
    for relative, record in files.items():
        if not source_path_allowed(relative):
            raise RuntimeError("Unsafe source manifest path")
        path = root / relative
        if path.stat().st_size != record["size"] or sha256(path) != record["sha256"] or stat.S_IMODE(path.stat().st_mode) != record["mode"]:
            raise RuntimeError("Source file checksum or mode mismatch: " + relative)
    check_source_inputs(root, files)
    return {"verified": True, "files": len(files), "manifestSha256": expected["manifestSha256"], "treeSha256": manifest["treeSha256"],
            "gitHead": manifest["gitHead"], "gitDirty": manifest["gitDirty"], "workerBuildInputsVerified": True,
            "applicationRebuilt": False}


def snapshot_files(target, previous):
    data = target / "files"
    data.mkdir(exist_ok=True)
    for name in ("uploads", "classrooms", "whiteboards"):
        source = PROJECT / ".openpbl-data" / name
        if not source.is_dir():
            raise RuntimeError(f"Required data directory is missing: {name}")
        destination = data / name
        args = ["rsync", "-a", "--no-owner", "--no-group", "--exclude=*.sqlite-shm", "--exclude=*.sqlite-wal", "--exclude=*.sqlite"]
        if previous and (previous / "files" / name).is_dir():
            args += ["--link-dest", str(previous / "files" / name)]
        run([*args, str(source) + "/", str(destination) + "/"], capture_output=True)
        # SQLite files must use the online backup API; copying a live WAL file
        # alone is not a valid whiteboard recovery point.
        for source_db in source.rglob("*.sqlite"):
            destination_db = destination / source_db.relative_to(source)
            destination_db.parent.mkdir(parents=True, exist_ok=True)
            # Connection.__exit__ commits but does not close. Close both before
            # enumerating hashes so temporary WAL/SHM files cannot enter the
            # manifest and disappear later when Python collects connections.
            with contextlib.closing(sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)) as src, \
                    contextlib.closing(sqlite3.connect(destination_db)) as dst:
                src.backup(dst)
                if dst.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RuntimeError("Whiteboard backup integrity failed")
    # Capacity evidence is optional on older deployments. Preserve its original
    # bytes outside disposable Playwright output, including interrupted reports;
    # a file checksum never upgrades the report's original business outcome.
    evidence = PROJECT / ".openpbl-data/capacity-evidence"
    if evidence.exists() or evidence.is_symlink():
        if evidence.is_symlink() or not evidence.is_dir():
            raise RuntimeError("Capacity evidence root must be a real directory")
        if any(item.is_symlink() for item in evidence.rglob("*")):
            raise RuntimeError("Capacity evidence cannot contain symlinks")
        destination = data / "capacity-evidence"
        args = ["rsync", "-a", "--no-owner", "--no-group"]
        if previous and (previous / "files/capacity-evidence").is_dir():
            args += ["--link-dest", str(previous / "files/capacity-evidence")]
        run([*args, str(evidence) + "/", str(destination) + "/"], capture_output=True)
        if any(item.is_symlink() for item in destination.rglob("*")):
            raise RuntimeError("Capacity evidence changed to a symlink during snapshot")
    config = target / "configuration"
    config.mkdir()
    for relative in (".env.local", "server-providers.yml", "deploy/.deploy.env", "deploy/secrets",
                     "docker-compose.prod.yml", "docker-compose.ip.yml", "deploy/systemd", "deploy/nginx",
                     "scripts/openpbl-production-service.sh", "scripts/run-next-production.mjs", "prisma/schema.prisma"):
        source = PROJECT / relative
        destination = config / relative
        if source.is_dir():
            shutil.copytree(source, destination)
        elif source.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    installed_units = Path.home() / ".config/systemd/user"
    for source in installed_units.glob("openpbl*.service"):
        destination = config / "installed-user-units" / source.name
        destination.parent.mkdir(exist_ok=True)
        shutil.copy2(source, destination)
    checksums = {str(path.relative_to(target)): {"sha256": sha256(path), "size": path.stat().st_size,
                                                "mode": stat.S_IMODE(path.stat().st_mode)}
                 for path in sorted(target.rglob("*")) if path.is_file()}
    # Directory-format dumps permit per-table deduplication. Large unchanged
    # textbook/vector tables should not consume a full extra copy every 5 min.
    if previous:
        previous_files = json.loads((previous / "manifest.json").read_text())["files"]
        for relative, checksum in checksums.items():
            existing = previous / relative
            current = target / relative
            if previous_files.get(relative) == checksum and existing.is_file() and current.stat().st_ino != existing.stat().st_ino:
                current.unlink()
                os.link(existing, current)
    return checksums


def snapshot_audit_outbox(target):
    # Copy before opening the database snapshot. A queued audit event removed
    # during this copy has already committed to the later DB snapshot; copying
    # after pg_dump could miss both the removed file and its newly inserted row.
    destination = target / "files/ai-audit-outbox"
    destination.mkdir(parents=True)
    source = PROJECT / ".openpbl-data/ai-audit-outbox"
    if source.is_dir():
        result = subprocess.run(["rsync", "-a", "--no-owner", "--no-group", str(source) + "/", str(destination) + "/"],
                                capture_output=True, check=False)
        if result.returncode not in (0, 24):
            raise RuntimeError("Could not snapshot the durable AI audit outbox")


def validate_assets(target, assets):
    for asset in assets:
        key = asset["storageKey"]
        if not key or Path(key).name != key or key in (".", ".."):
            raise RuntimeError("Unsafe asset storage key in database")
        path = target / "files/uploads" / key
        if not path.is_file():
            raise RuntimeError(f"Database-referenced upload is missing: {asset['id']}")
        if asset["sha256"] and sha256(path) != asset["sha256"]:
            raise RuntimeError(f"Database-referenced upload checksum mismatch: {asset['id']}")


def ensure_wal_received(lsn, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        active = sql(f"SELECT EXISTS (SELECT FROM pg_stat_replication r JOIN pg_replication_slots s ON s.active_pid=r.pid WHERE s.slot_name='{SLOT}' AND r.flush_lsn >= '{lsn}'::pg_lsn)")
        if active == "t":
            return
        time.sleep(1)
    raise RuntimeError("Continuous WAL receiver has not durably flushed the recovery point")


def prune():
    cutoff = time.time() - RETENTION_DAYS * 86400
    current_bases = bases()
    # Keep the base immediately before the 30-day boundary to replay any
    # retained recovery point, plus every newer base.
    older = [path for path in current_bases if json.loads((path / "complete.json").read_text())["completedEpoch"] < cutoff]
    for path in older[:-1]:
        shutil.rmtree(path)
    for path in snapshots():
        if json.loads((path / "manifest.json").read_text())["startedEpoch"] < cutoff:
            shutil.rmtree(path)
    current_bases = bases()
    if current_bases:
        earliest = json.loads((current_bases[0] / "complete.json").read_text())["firstWal"]
        for path in (ROOT / "wal").iterdir():
            # Never remove partial or history files, or a different timeline.
            if re.fullmatch(r"[0-9A-F]{24}", path.name) and path.name[:8] == earliest[:8] and path.name < earliest:
                path.unlink()


def backup():
    with lock():
        # A failed/interrupted attempt never becomes a recovery point. Remove
        # only unfinished backup-owned directories, so repeated failures cannot
        # accumulate a full data copy every five minutes.
        for parent, marker in ((ROOT / "bases", "complete.json"), (ROOT / "snapshots", "manifest.json")):
            for path in parent.iterdir():
                if re.fullmatch(r"\d{8}T\d{12}Z", path.name) and path.is_dir() and not (path / marker).exists():
                    shutil.rmtree(path)
        if shutil.disk_usage(ROOT).free < 10 * 1024**3:
            raise RuntimeError("Less than 10 GiB free; refusing a new snapshot")
        base = take_base()
        previous = snapshots()
        target = ROOT / "snapshots" / stamp()
        target.mkdir()
        started = time.time()
        snapshot_audit_outbox(target)
        records, assets = dump_consistent(target)
        source = snapshot_source(target)
        files = snapshot_files(target, previous[-1] if previous else None)
        validate_assets(target, assets)
        restore_point = "openpbl_local_" + target.name
        lsn = sql(f"SELECT pg_create_restore_point('{restore_point}')")
        sql("SELECT pg_switch_wal();")
        ensure_wal_received(lsn)
        manifest = {"startedEpoch": started, "completedEpoch": time.time(), "base": base.name,
                    "restorePoint": restore_point, "lsn": lsn, "tables": records, "assets": assets,
                    "files": files, "recoverySettings": recovery_settings(),
                    "gitSha": source["gitHead"], "source": source}
        write_json(target / "manifest.json", manifest)
        # Flush the filesystem before acknowledging the recovery point.
        os.sync()
        write_json(ROOT / "status/last-success.json", {"snapshot": target.name, "startedEpoch": started,
                    "completedEpoch": time.time(), "fileCount": len(files), "assetCount": len(assets)})
        prune()
        print(json.dumps({"snapshot": target.name, "seconds": round(time.time() - started, 2),
                          "tables": len(records), "files": len(files), "assets": len(assets)}), flush=True)


def health_snapshot():
    value = json.loads((ROOT / "status/last-success.json").read_text())
    value["recoveryPointAgeSeconds"] = round(time.time() - value["startedEpoch"], 1)
    value["wal"] = json.loads(sql("SELECT coalesce(json_agg(json_build_object('active', active, 'status', wal_status, 'lagBytes', pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))), '[]') FROM pg_replication_slots WHERE slot_name='openpbl_local_backup'"))
    value["healthy"] = value["recoveryPointAgeSeconds"] <= 900 and bool(value["wal"]) and value["wal"][0]["active"] and value["wal"][0]["status"] != "lost"
    return value


def status():
    value = health_snapshot()
    print(json.dumps(value))
    return 0 if value["healthy"] else 1


def unit_property(unit, property_name):
    return output(["systemctl", "--user", "show", unit, "--property", property_name, "--value"])


def monitor():
    reasons = []
    details = {}
    try:
        details = health_snapshot()
        if not details["healthy"]:
            reasons.append("recovery point older than 900 seconds or WAL receiver unavailable")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        reasons.append("complete recovery point or database check unavailable")
    try:
        result = unit_property("openpbl-local-backup.service", "Result")
        if result != "success":
            reasons.append("last backup service result: " + result)
        for unit in ("openpbl-local-wal.service", "openpbl-local-backup.timer"):
            if unit_property(unit, "ActiveState") != "active":
                reasons.append(unit + " is not active")
    except (OSError, subprocess.SubprocessError):
        reasons.append("backup systemd service state unavailable")
    state = "alert" if reasons else "ok"
    path = ROOT / "status/health.json"
    try:
        previous = json.loads(path.read_text())
    except (OSError, ValueError):
        previous = {}
    write_json(path, {"checkedEpoch": time.time(), "state": state, "reasons": reasons, "backup": details})
    if previous.get("state") != state or previous.get("reasons") != reasons:
        print(json.dumps({"event": "local-backup-health-change", "state": state, "reasons": reasons}), flush=True)
    return 1 if reasons else 0


def verify_files(snapshot):
    manifest = json.loads((snapshot / "manifest.json").read_text())
    for relative, expected in manifest["files"].items():
        file = snapshot / relative
        if not file.is_file() or file.stat().st_size != expected["size"] or sha256(file) != expected["sha256"] \
                or ("mode" in expected and stat.S_IMODE(file.stat().st_mode) != expected["mode"]):
            raise RuntimeError(f"Snapshot file checksum mismatch: {relative}")
    validate_assets(snapshot, manifest["assets"])
    if manifest.get("source"):
        verify_source(snapshot, manifest["source"])
    return manifest


def drill(verify_recovered=None):
    with lock():
        started = time.time()
        snapshot = snapshots()[-1]
        manifest = verify_files(snapshot)
        work = ROOT / "drills" / stamp()
        work.mkdir()
        shutil.copytree(snapshot / "files", work / "files")
        source_verification = {"verified": False, "reason": "historical snapshot has no source tree", "applicationRebuilt": False}
        if manifest.get("source"):
            shutil.copytree(snapshot / "source", work / "source")
            shutil.copy2(snapshot / "source-manifest.json", work / "source-manifest.json")
            source_verification = verify_source(work, manifest["source"])
        for relative, expected in manifest["files"].items():
            if relative.startswith("files/") and sha256(work / relative) != expected["sha256"]:
                raise RuntimeError("Restored application file checksum mismatch")
        validate_assets(work, manifest["assets"])
        name = "openpbl-local-drill-" + str(os.getpid())
        base = ROOT / "bases" / manifest["base"]
        # Copy, never hard-link, the PostgreSQL data directory. The drill has no
        # host network, published port, or production data volume.
        shutil.copytree(base / "data", work / "postgres")
        data = work / "postgres"
        (data / "standby.signal").unlink(missing_ok=True)
        (data / "recovery.signal").touch()
        with (data / "postgresql.auto.conf").open("a") as handle:
            handle.write("\nrestore_command = 'cp /wal/%f %p'\n")
            handle.write(f"recovery_target_name = '{manifest['restorePoint']}'\n")
            handle.write("recovery_target_action = 'promote'\n")
        # Command-line production settings are not captured in PGDATA. WAL
        # recovery requires these settings to be at least the primary values.
        base_settings = json.loads((base / "complete.json").read_text()).get("recoverySettings", {})
        settings = manifest.get("recoverySettings") or base_settings or recovery_settings()
        recovery_args = []
        for key in RECOVERY_SETTINGS:
            recovery_args += ["-c", f"{key}={max(int(settings[key]), int(base_settings.get(key, 0)))}"]
        try:
            run(["docker", "run", "-d", "--name", name, "--network=none",
                 "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{data}:/data",
                 "-v", f"{ROOT / 'wal'}:/wal:ro", "-v", f"{snapshot}:/snapshot:ro",
                 "--entrypoint", "postgres", json.loads((base / "complete.json").read_text())["image"],
                 "-D", "/data", "-p", PORT, "-k", "/tmp", "-h", "", "-c", "shared_buffers=128MB",
                 *recovery_args], capture_output=True)

            def drill_sql(statement, database=DATABASE, readonly=False):
                prefix = ["docker", "exec"]
                if readonly:
                    prefix += ["-e", "PGOPTIONS=-c default_transaction_read_only=on"]
                return output([*prefix, name, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                               "-h", "/tmp", "-p", PORT, "-U", DB_USER, "-d", database, "-c", statement])

            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                try:
                    if drill_sql("SELECT NOT pg_is_in_recovery()") == "t":
                        break
                except subprocess.CalledProcessError:
                    if output(["docker", "inspect", "--format", "{{.State.Running}}", name]) != "true":
                        raise RuntimeError("Isolated PostgreSQL exited before completing WAL recovery")
                time.sleep(1)
            else:
                raise RuntimeError("Isolated physical recovery did not reach its named WAL restore point")
            physical_counts = {table: json.loads(drill_sql(table_fingerprint_sql(table)))["count"]
                               for table in manifest["tables"]}
            # Logical recovery uses the exact exported snapshot; verify every
            # table's complete canonical row digest, not just a few counters.
            drill_sql('CREATE DATABASE openpbl_logical_drill TEMPLATE template0')
            run(["docker", "exec", name, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges",
                 "-h", "/tmp", "-p", PORT, "-U", DB_USER, "-d", "openpbl_logical_drill",
                 "/snapshot/database" if (snapshot / "database").is_dir() else "/snapshot/database.dump"], capture_output=True)
            for table, expected in manifest["tables"].items():
                if json.loads(drill_sql(table_fingerprint_sql(table), "openpbl_logical_drill")) != expected:
                    raise RuntimeError(f"Restored table does not match the acknowledged snapshot: {table}")
            # Optional acceptance assertions run only against this newly restored
            # database and copied files, before finally removes the isolated copy.
            verification = verify_recovered(
                lambda statement: drill_sql(statement, "openpbl_logical_drill", readonly=True), work, snapshot
            ) if verify_recovered else None
            report = {"snapshot": snapshot.name, "completedEpoch": time.time(), "durationSeconds": round(time.time() - started, 2),
                      "recoveryPointAgeAtStartSeconds": round(started - manifest["startedEpoch"], 2),
                      "tablesVerified": len(manifest["tables"]), "rowsVerified": sum(row["count"] for row in manifest["tables"].values()),
                      "filesVerified": len(manifest["files"]), "assetsVerified": len(manifest["assets"]),
                      "physicalWalRecovery": True, "physicalTableCounts": physical_counts, "sourceRecovery": source_verification,
                      "rtoWithin60Minutes": time.time() - started <= 3600}
            if verification is not None:
                report["capacityVerification"] = verification
            write_json(ROOT / "status/last-drill.json", report)
            print(json.dumps({key: value for key, value in report.items() if key != "physicalTableCounts"}))
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
            # Only this unique, newly allocated isolated copy is removed.
            shutil.rmtree(work)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "wal", "backup", "status", "monitor", "drill"))
    args = parser.parse_args()
    initialize_dirs()
    actions = {"setup": setup, "wal": receive_wal, "backup": backup, "status": status, "monitor": monitor, "drill": drill}
    return actions[args.command]() or 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BlockingIOError:
        print("A local backup or restore drill already holds the backup lock; no duplicate job started.")
        sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] == "backup" else 1)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        # Do not print database stderr, config contents, credentials or SQL data.
        print(f"Local backup failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
