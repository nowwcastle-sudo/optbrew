"""Validate the complete portable Agent Plugins manifest schema (dev tool only)."""
import argparse
import importlib.metadata as metadata
import json
import re
from pathlib import Path

from jsonschema.validators import validator_for


def dependencies():
    """Record the installed validator and direct/transitive license metadata."""
    found = {}
    pending = ["jsonschema"]
    while pending:
        name = pending.pop()
        key = re.sub(r"[-_.]+", "-", name).lower()
        if key in found:
            continue
        dist = metadata.distribution(name)
        found[key] = {
            "version": dist.version,
            "license": dist.metadata.get("License-Expression") or dist.metadata.get("License") or [
                value for value in dist.metadata.get_all("Classifier", [])
                if value.startswith("License ::")
            ],
        }
        for requirement in dist.requires or []:
            if ";" in requirement:
                continue  # Optional extra or environment marker; absent from this runtime path.
            pending.append(re.split(r"[<>=!~\[ ;]", requirement, maxsplit=1)[0])
    return found


def validate(schema_path: Path, manifest_path: Path):
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validator = validator_for(schema)
    validator.check_schema(schema)
    errors = sorted(validator(schema).iter_errors(manifest), key=lambda error: list(map(str, error.path)))
    return {
        "status": "invalid" if errors else "valid",
        "schema_id": schema.get("$id"),
        "validator": validator.__name__,
        "dependencies": dependencies(),
        "errors": [{"path": "/".join(map(str, error.path)), "message": error.message} for error in errors],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    result = validate(args.schema, args.manifest)
    output = json.dumps(result, ensure_ascii=False, indent=2)
    print(output)
    if args.receipt:
        args.receipt.write_text(output + "\n", encoding="utf-8")
    raise SystemExit(0 if result["status"] == "valid" else 1)
