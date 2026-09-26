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
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")


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
    return run(pg_args(container), input=statement, capture_output=True).stdout.strip()


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
    if available and time.time() - json.loads((available[-1] / "complete.json").read_text())["completedEpoch"] < 86400:
        return available[-1]
    target = ROOT / "bases" / stamp()
    target.mkdir()
    run(client("pg_basebackup", "-h", "127.0.0.1", "-p", PORT, "-U", REPLICATION_USER,
               "-D", target / "data", "--wal-method=stream", "--checkpoint=spread", "--manifest-checksums=SHA256"))
    run(client("/usr/lib/postgresql/16/bin/pg_verifybackup", target / "data"), capture_output=True)
    manifest = json.loads((target / "data/backup_manifest").read_text())
    wal_range = manifest["WAL-Ranges"][0]
    first_wal = sql(f"SELECT pg_walfile_name('{wal_range['Start-LSN']}')")
    write_json(target / "complete.json", {"completedEpoch": time.time(), "image": image(), "firstWal": first_wal})
    print(f"Verified PostgreSQL base: {target.name}", flush=True)
    return target


def table_fingerprint_sql(table):
    quoted = '"' + table.replace('"', '""') + '"'
    # Hash canonical jsonb per row, then a sorted sequence of those hashes.
    # Report contains no raw student, credential or conversation content.
    return ("SELECT json_build_object('count', count(*), 'digest', "
            "md5(coalesce(string_agg(h, '' ORDER BY h), ''))) "
            f"FROM (SELECT md5(to_jsonb(t)::text) h FROM public.{quoted} t) rows;")


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
                   "--snapshot", snapshot_id, "--format=custom", "--file", target / "database.dump"))
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


def snapshot_files(target, previous):
    data = target / "files"
    data.mkdir()
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
            with sqlite3.connect(f"file:{source_db}?mode=ro", uri=True) as src, sqlite3.connect(destination_db) as dst:
                src.backup(dst)
                if dst.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RuntimeError("Whiteboard backup integrity failed")
    config = target / "configuration"
    config.mkdir()
    for relative in (".env.local", "server-providers.yml", "deploy/.deploy.env", "deploy/secrets",
                     "docker-compose.prod.yml", "docker-compose.ip.yml", "deploy/systemd", "deploy/nginx"):
        source = PROJECT / relative
        destination = config / relative
        if source.is_dir():
            shutil.copytree(source, destination)
        elif source.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    return {str(path.relative_to(target)): {"sha256": sha256(path), "size": path.stat().st_size}
            for path in sorted(target.rglob("*")) if path.is_file()}


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
        active = sql(f"SELECT EXISTS (SELECT FROM pg_stat_replication WHERE application_name='pg_receivewal' AND flush_lsn >= '{lsn}'::pg_lsn)")
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
        if shutil.disk_usage(ROOT).free < 10 * 1024**3:
            raise RuntimeError("Less than 10 GiB free; refusing a new snapshot")
        base = take_base()
        previous = snapshots()
        target = ROOT / "snapshots" / stamp()
        target.mkdir()
        started = time.time()
        records, assets = dump_consistent(target)
        files = snapshot_files(target, previous[-1] if previous else None)
        validate_assets(target, assets)
        restore_point = "openpbl_local_" + target.name
        lsn = sql(f"SELECT pg_create_restore_point('{restore_point}')")
        sql("SELECT pg_switch_wal();")
        ensure_wal_received(lsn)
        manifest = {"startedEpoch": started, "completedEpoch": time.time(), "base": base.name,
                    "restorePoint": restore_point, "lsn": lsn, "tables": records, "assets": assets,
                    "files": files, "gitSha": output(["git", "-C", PROJECT, "rev-parse", "HEAD"])}
        write_json(target / "manifest.json", manifest)
        # Flush the filesystem before acknowledging the recovery point.
        os.sync()
        write_json(ROOT / "status/last-success.json", {"snapshot": target.name, "startedEpoch": started,
                    "completedEpoch": time.time(), "fileCount": len(files), "assetCount": len(assets)})
        prune()
        print(json.dumps({"snapshot": target.name, "seconds": round(time.time() - started, 2),
                          "tables": len(records), "files": len(files), "assets": len(assets)}), flush=True)


def status():
    value = json.loads((ROOT / "status/last-success.json").read_text())
    value["recoveryPointAgeSeconds"] = round(time.time() - value["startedEpoch"], 1)
    value["wal"] = json.loads(sql("SELECT coalesce(json_agg(json_build_object('active', active, 'status', wal_status, 'lagBytes', pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))), '[]') FROM pg_replication_slots WHERE slot_name='openpbl_local_backup'"))
    value["healthy"] = value["recoveryPointAgeSeconds"] <= 900 and bool(value["wal"]) and value["wal"][0]["active"] and value["wal"][0]["status"] != "lost"
    print(json.dumps(value))
    return 0 if value["healthy"] else 1


def verify_files(snapshot):
    manifest = json.loads((snapshot / "manifest.json").read_text())
    for relative, expected in manifest["files"].items():
        file = snapshot / relative
        if not file.is_file() or file.stat().st_size != expected["size"] or sha256(file) != expected["sha256"]:
            raise RuntimeError(f"Snapshot file checksum mismatch: {relative}")
    validate_assets(snapshot, manifest["assets"])
    return manifest


def drill():
    with lock():
        started = time.time()
        snapshot = snapshots()[-1]
        manifest = verify_files(snapshot)
        work = ROOT / "drills" / stamp()
        work.mkdir()
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
        try:
            run(["docker", "run", "--rm", "-d", "--name", name, "--network=none",
                 "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{data}:/data",
                 "-v", f"{ROOT / 'wal'}:/wal:ro", "-v", f"{snapshot}:/snapshot:ro",
                 "--entrypoint", "postgres", json.loads((base / "complete.json").read_text())["image"],
                 "-D", "/data", "-p", PORT, "-k", "/tmp", "-h", "", "-c", "shared_buffers=128MB"], capture_output=True)

            def drill_sql(statement, database=DATABASE):
                return output(["docker", "exec", name, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                               "-h", "/tmp", "-p", PORT, "-U", DB_USER, "-d", database, "-c", statement])

            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                try:
                    if drill_sql("SELECT NOT pg_is_in_recovery()") == "t":
                        break
                except subprocess.CalledProcessError:
                    pass
                time.sleep(1)
            else:
                raise RuntimeError("Isolated physical recovery did not reach its named WAL restore point")
            physical_counts = {table: json.loads(drill_sql(table_fingerprint_sql(table)))["count"]
                               for table in manifest["tables"]}
            # Logical recovery uses the exact exported snapshot; verify every
            # table's complete canonical row digest, not just a few counters.
            drill_sql('CREATE DATABASE openpbl_logical_drill TEMPLATE template0')
            run(["docker", "exec", name, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges",
                 "-h", "/tmp", "-p", PORT, "-U", DB_USER, "-d", "openpbl_logical_drill", "/snapshot/database.dump"], capture_output=True)
            for table, expected in manifest["tables"].items():
                if json.loads(drill_sql(table_fingerprint_sql(table), "openpbl_logical_drill")) != expected:
                    raise RuntimeError(f"Restored table does not match the acknowledged snapshot: {table}")
            report = {"snapshot": snapshot.name, "completedEpoch": time.time(), "durationSeconds": round(time.time() - started, 2),
                      "recoveryPointAgeAtStartSeconds": round(started - manifest["startedEpoch"], 2),
                      "tablesVerified": len(manifest["tables"]), "rowsVerified": sum(row["count"] for row in manifest["tables"].values()),
                      "filesVerified": len(manifest["files"]), "assetsVerified": len(manifest["assets"]),
                      "physicalWalRecovery": True, "physicalTableCounts": physical_counts,
                      "rtoWithin60Minutes": time.time() - started <= 3600}
            write_json(ROOT / "status/last-drill.json", report)
            print(json.dumps({key: value for key, value in report.items() if key != "physicalTableCounts"}))
        finally:
            run(["docker", "rm", "-f", name], capture_output=True)
            # Only this unique, newly allocated isolated copy is removed.
            shutil.rmtree(work)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "wal", "backup", "status", "drill"))
    args = parser.parse_args()
    initialize_dirs()
    actions = {"setup": setup, "wal": receive_wal, "backup": backup, "status": status, "drill": drill}
    return actions[args.command]() or 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        # Do not print database stderr, config contents, credentials or SQL data.
        print(f"Local backup failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
