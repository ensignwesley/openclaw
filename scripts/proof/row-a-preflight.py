#!/usr/bin/env python3
"""Fail before setup when a copied proof fixture is missing or not its pinned bytes."""
import hashlib, pathlib, subprocess
FILES = {'scripts/proof/remote-prefix-proof.ts.txt': 'bda3803d402823cffaf4e4d7e988a19ce3a5251f7a86ac456d6979c7b35cf01b', 'scripts/proof/class-table.ts.txt': 'd2357c29e194835d2bd42b2aa90375907cb2c9dae890cb0c28a8ae6af1971060', 'src/skills/runtime/legacy-precedence.integration.test.ts': 'f120bc93e4932c0fc3f32320a79e53981189dc1a1fa602119422c9c6eb69f2a1'}
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