"""Inspect an offline SQLite snapshot without opening the original in SQLite.

No row values are exported. A pass checks structural consistency and counts;
it does not certify that a snapshot contains every production transaction.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone


def inventory(database):
    result = {}
    for suffix in ("", "-wal", "-shm", "-journal"):
        path = Path(str(database) + suffix)
        if path.exists():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            result[suffix] = {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}
    return result


def inspect(database, baseline=None):
    database = database.resolve(strict=True)
    with database.open("rb") as stream:
        if stream.read(16) != b"SQLite format 3\0":
            raise ValueError("Not a SQLite 3 database file")
    before = inventory(database)
    if before.get("-journal", {}).get("bytes", 0):
        raise ValueError("Rollback journal present: obtain a clean offline snapshot before inspection")
    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "databaseFile": database.name,
        "sqliteVersion": sqlite3.sqlite_version,
        "files": before,
        "tableCounts": {},
        "inspectionErrors": [],
    }
    # SQLite may create/update SHM even on read-only WAL connections. It only
    # opens this disposable copy, keeping the user's original files untouched.
    with tempfile.TemporaryDirectory(prefix="harmony-sqlite-check-") as directory:
        snapshot = Path(directory) / database.name
        for suffix in before:
            shutil.copyfile(Path(str(database) + suffix), Path(str(snapshot) + suffix))
        if inventory(snapshot) != before or inventory(database) != before:
            raise ValueError("Snapshot files changed during copy; stop writers and obtain a consistent backup")
        connection = sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True)
        try:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            report["integrityCheck"] = [row[0] for row in connection.execute("PRAGMA integrity_check")]
            report["foreignKeyViolationCount"] = sum(1 for _ in connection.execute("PRAGMA foreign_key_check"))
            tables = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
            for (name,) in tables:
                quoted = '"' + name.replace('"', '""') + '"'
                try:
                    report["tableCounts"][name] = connection.execute("SELECT COUNT(*) FROM " + quoted).fetchone()[0]
                except sqlite3.Error as error:
                    report["inspectionErrors"].append({"table": name, "message": str(error)})
        finally:
            connection.close()
    report["sourceFilesUnchanged"] = inventory(database) == before
    report["missingRequiredTables"] = sorted({"Product", "ImageAsset", "QuerySession"} - report["tableCounts"].keys())
    report["countComparison"] = None
    if baseline is not None:
        if not isinstance(baseline, dict) or not baseline.get("snapshotCheckPassed") or not isinstance(baseline.get("tableCounts"), dict):
            raise ValueError("Baseline must be a successful report produced by this script")
        expected = baseline["tableCounts"]
        names = sorted(set(expected) | set(report["tableCounts"]))
        report["countComparison"] = {
            "passed": expected == report["tableCounts"],
            "differences": [{"table": name, "baseline": expected.get(name), "actual": report["tableCounts"].get(name)}
                            for name in names if expected.get(name) != report["tableCounts"].get(name)],
        }
    report["snapshotCheckPassed"] = (
        report["sourceFilesUnchanged"] and report["integrityCheck"] == ["ok"]
        and report["foreignKeyViolationCount"] == 0 and not report["missingRequiredTables"]
        and not report["inspectionErrors"]
        and (report["countComparison"] is None or report["countComparison"]["passed"])
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Database extracted from a consistent offline backup")
    parser.add_argument("--compare", type=Path, help="Earlier successful JSON report to compare all table counts")
    args = parser.parse_args()
    try:
        baseline = json.loads(args.compare.read_text(encoding="utf-8-sig")) if args.compare else None
        report = inspect(args.database, baseline)
    except (OSError, ValueError, sqlite3.Error) as error:
        report = {"snapshotCheckPassed": False, "inspectionError": str(error),
                  "note": "Inspection failure may indicate missing SQLite extensions, incompatible SQLite, or an inconsistent snapshot; it alone does not prove corruption."}
    # ASCII JSON also works with Windows PowerShell 5 output redirection.
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report["snapshotCheckPassed"] else 1


if __name__ == "__main__":
    sys.exit(main())
