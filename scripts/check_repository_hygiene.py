#!/usr/bin/env python3
"""Reject tracked private data, local databases and environment files."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]


def reason(path: str) -> str | None:
    name = PurePosixPath(path).name.lower()
    lower = path.lower()
    if lower.startswith("ml/data/") or lower.startswith("private-artifacts/"):
        return "private data directory"
    if lower.startswith("ml/disease_risk/datasets/") and name.endswith("_incidence_w1w2.csv"):
        return "respondent-level CHARLS data"
    if (name == ".env" or name.startswith(".env.")) and name != ".env.example":
        return "environment secrets"
    if name.endswith((".db", ".db-shm", ".db-wal", ".db-journal", ".sqlite", ".sqlite3")):
        return "local database"
    return None


def main() -> int:
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8")
    violations = [
        (path, finding)
        for path in tracked.split("\0")
        if path and (finding := reason(path))
    ]
    if violations:
        for path, finding in violations:
            print(f"{path}: {finding}", file=sys.stderr)
        return 1
    print("Tracked-file hygiene: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
