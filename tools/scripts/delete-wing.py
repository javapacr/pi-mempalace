#!/usr/bin/env python3
"""Delete all drawers/closets belonging to a MemPalace wing.

Called by the pi mempalace extension tool. Returns JSON.
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import chromadb
except ImportError as e:
    print(json.dumps({"error": f"chromadb not installed: {e}"}), file=sys.stderr)
    sys.exit(1)


def resolve_palace(palace: str | None) -> str:
    if palace:
        return os.path.expanduser(palace)
    # Prefer MEMPALACE_PALACE_PATH, then CVP palace, then default palace.
    if os.environ.get("MEMPALACE_PALACE_PATH"):
        return os.path.expanduser(os.environ["MEMPALACE_PALACE_PATH"])
    home = Path.home()
    cwd = Path.cwd()
    cvp_root = home / "Documents" / "projects" / "tml" / "cvp"
    if cwd == cvp_root or str(cwd).startswith(str(cvp_root) + os.sep):
        return str(home / ".config" / "mempalace" / "cvp")
    return str(home / ".config" / "mempalace" / "palace")


def delete_wing(palace: str, wing: str, dry_run: bool) -> dict:
    client = chromadb.PersistentClient(path=palace)
    result = {"palace": palace, "wing": wing, "dry_run": dry_run, "collections": {}}
    total_deleted = 0

    for collection_name in ["mempalace_drawers", "mempalace_closets"]:
        try:
            col = client.get_collection(collection_name)
        except Exception as e:
            result["collections"][collection_name] = {
                "status": "missing",
                "error": str(e),
            }
            continue

        try:
            records = col.get(where={"wing": wing}, include=[])
            ids = records.get("ids", [])
        except Exception as e:
            result["collections"][collection_name] = {
                "status": "query_failed",
                "error": str(e),
            }
            continue

        count = len(ids)
        result["collections"][collection_name] = {"count": count}

        if count == 0:
            continue

        if not dry_run:
            try:
                # ChromaDB can fail on very large delete batches; chunk it.
                batch_size = 5000
                deleted = 0
                for i in range(0, count, batch_size):
                    batch = ids[i : i + batch_size]
                    col.delete(ids=batch)
                    deleted += len(batch)
                result["collections"][collection_name]["deleted"] = deleted
                total_deleted += deleted
            except Exception as e:
                result["collections"][collection_name]["status"] = "delete_failed"
                result["collections"][collection_name]["error"] = str(e)
        else:
            total_deleted += count

    result["total_deleted"] = total_deleted
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Delete a MemPalace wing")
    parser.add_argument("--palace", help="Path to the palace directory")
    parser.add_argument("--wing", required=True, help="Wing name to delete")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Count drawers that would be deleted without deleting",
    )
    args = parser.parse_args()

    palace = resolve_palace(args.palace)
    if not Path(palace).exists():
        print(json.dumps({"error": f"Palace not found: {palace}"}), file=sys.stderr)
        return 1

    result = delete_wing(palace, args.wing, dry_run=args.dry_run)
    print(json.dumps(result, indent=2))
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    sys.exit(main())
