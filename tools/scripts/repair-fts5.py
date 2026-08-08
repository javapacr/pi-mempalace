#!/usr/bin/env python3
"""Rebuild the MemPalace ChromaDB FTS5 full-text index.

Corruption of the `embedding_fulltext_search` FTS5 virtual table
(e.g. "malformed inverted index") breaks full-text search while the
underlying embeddings/drawers are usually intact. This script backs up
the palace, drops and recreates the FTS5 table, repopulates it from
embedding_metadata, verifies `PRAGMA quick_check`, and optionally runs
`mempalace repair --yes`.
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

FTS5_TABLE = "embedding_fulltext_search"
FTS5_COLUMNS = "string_value"
FTS5_TOKENIZE = "trigram"


def resolve_palace(palace: str | None) -> str:
    if palace:
        return os.path.expanduser(palace)
    if os.environ.get("MEMPALACE_PALACE_PATH"):
        return os.path.expanduser(os.environ["MEMPALACE_PALACE_PATH"])
    home = Path.home()
    cwd = Path.cwd()
    cvp_root = home / "Documents" / "projects" / "tml" / "cvp"
    if cwd == cvp_root or str(cwd).startswith(str(cvp_root) + os.sep):
        return str(home / ".config" / "mempalace" / "cvp")
    return str(home / ".config" / "mempalace" / "palace")


def quick_check(conn: sqlite3.Connection) -> tuple[bool, str]:
    cur = conn.cursor()
    cur.execute("PRAGMA quick_check;")
    rows = cur.fetchall()
    text = "\n".join(str(r[0]) for r in rows) if rows else ""
    ok = text.strip().lower() == "ok"
    return ok, text


def fts5_count(conn: sqlite3.Connection) -> int:
    cur = conn.cursor()
    try:
        cur.execute(f"SELECT COUNT(*) FROM {FTS5_TABLE};")
        return cur.fetchone()[0]
    except sqlite3.Error:
        return -1


def metadata_string_count(conn: sqlite3.Connection) -> int:
    cur = conn.cursor()
    cur.execute(
        "SELECT COUNT(*) FROM embedding_metadata WHERE string_value IS NOT NULL;"
    )
    return cur.fetchone()[0]


def rebuild_fts5(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(f"DROP TABLE IF EXISTS {FTS5_TABLE};")
    cur.execute(
        f"CREATE VIRTUAL TABLE {FTS5_TABLE} "
        f"USING fts5({FTS5_COLUMNS}, tokenize='{FTS5_TOKENIZE}');"
    )
    cur.execute(
        f"INSERT INTO {FTS5_TABLE}(rowid, {FTS5_COLUMNS}) "
        "SELECT rowid, string_value FROM embedding_metadata WHERE string_value IS NOT NULL;"
    )


def backup_palace(palace: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = f"{palace}-backup-{timestamp}"
    shutil.copytree(palace, backup_path)
    return backup_path


def run_mempalace_repair(palace: str, timeout: int) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["mempalace", "--palace", palace, "repair", "--yes"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode == 0, (result.stdout + result.stderr).strip()
    except subprocess.TimeoutExpired:
        return False, f"mempalace repair timed out after {timeout}s"
    except Exception as e:
        return False, str(e)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild MemPalace FTS5 full-text index"
    )
    parser.add_argument("--palace", help="Path to the palace directory")
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Skip backing up the palace directory",
    )
    parser.add_argument(
        "--repair",
        action="store_true",
        help="Also run `mempalace repair --yes` after FTS5 rebuild",
    )
    parser.add_argument(
        "--repair-timeout",
        type=int,
        default=600,
        help="Timeout in seconds for `mempalace repair` (default: 600)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rebuild FTS5 even if PRAGMA quick_check passes",
    )
    args = parser.parse_args()

    palace = resolve_palace(args.palace)
    result: dict = {
        "palace": palace,
        "backup": None,
        "before": {},
        "after": {},
        "mempalace_repair": None,
    }

    if not Path(palace).exists():
        print(
            json.dumps({"error": f"Palace not found: {palace}"}),
            file=sys.stderr,
        )
        return 1

    db_path = os.path.join(palace, "chroma.sqlite3")
    if not Path(db_path).exists():
        print(
            json.dumps({"error": f"SQLite DB not found: {db_path}"}),
            file=sys.stderr,
        )
        return 1

    try:
        if not args.no_backup:
            result["backup"] = backup_palace(palace)

        conn = sqlite3.connect(db_path)
        try:
            ok_before, msg_before = quick_check(conn)
            result["before"] = {
                "ok": ok_before,
                "message": msg_before,
                "fts5_count": fts5_count(conn),
                "metadata_string_count": metadata_string_count(conn),
            }

            mismatch = (
                result["before"]["fts5_count"]
                != result["before"]["metadata_string_count"]
            )

            if ok_before and not mismatch and not args.force:
                result["action"] = "skipped"
                result["reason"] = (
                    "PRAGMA quick_check ok and FTS5 count matches metadata"
                )
            else:
                result["action"] = "rebuilt"
                if ok_before and (mismatch or args.force):
                    result["reason"] = (
                        "FTS5 count mismatch detected" if mismatch else "forced rebuild"
                    )
                rebuild_fts5(conn)
                conn.commit()

            ok_after, msg_after = quick_check(conn)
            result["after"] = {
                "ok": ok_after,
                "message": msg_after,
                "fts5_count": fts5_count(conn),
                "metadata_string_count": metadata_string_count(conn),
            }

            if not ok_after:
                print(
                    json.dumps(
                        {
                            "error": "PRAGMA quick_check still failing after rebuild",
                            "result": result,
                        }
                    ),
                    file=sys.stderr,
                )
                return 1
        finally:
            conn.close()

        if args.repair:
            repair_ok, repair_msg = run_mempalace_repair(palace, args.repair_timeout)
            result["mempalace_repair"] = {
                "ok": repair_ok,
                "output": repair_msg,
            }

        print(json.dumps(result, indent=2))
        return 0
    except Exception as e:
        print(
            json.dumps({"error": str(e), "result": result}),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
