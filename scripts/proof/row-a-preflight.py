#!/usr/bin/env python3
"""Fail before setup when a copied proof fixture is missing or not its pinned bytes."""
import hashlib, pathlib, subprocess
FILES = {'src/skills/runtime/remote-prefix-proof.integration.test.ts': 'bda3803d402823cffaf4e4d7e988a19ce3a5251f7a86ac456d6979c7b35cf01b', 'src/skills/runtime/legacy-precedence.integration.test.ts': 'cf9fd53c924685ad087ae2698c2ea2392be3d3327ff2cfadf1952175c1021cff'}
for name, expected in FILES.items():
    path = pathlib.Path(name)
    if not path.is_file():
        raise SystemExit("Missing proof-tree copy input: " + name)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit("Unexpected proof-tree copy input bytes: " + name)
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", name], capture_output=True)
    if tracked.returncode:
        raise SystemExit("Copy input is not included in proof tree: " + name)
print("All copied fixtures present, tracked, and exact pinned bytes")
