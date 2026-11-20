#!/usr/bin/env python3
"""Fail before setup when a copied proof fixture is missing or not its pinned bytes."""
import hashlib, pathlib, subprocess
FILES = {'scripts/proof/remote-prefix-proof.ts.txt': 'bda3803d402823cffaf4e4d7e988a19ce3a5251f7a86ac456d6979c7b35cf01b', 'src/skills/runtime/legacy-precedence.integration.test.ts': '92a4edfb2d2a1569f6d4b468d9bc8e000a8d190bb78f4ab1ef81642038552b15', 'scripts/proof/remote-note-review.ts.txt': '65e18781a5c3c69b77a27e69a86b46cf14bcf5e7063c091634b28a91762d6419', 'scripts/proof/separated-recovery.ts.txt': '377d06862a1cd7bef463d8541ee84129d2a49ab41416e16012b743e3aebe2210'}
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
