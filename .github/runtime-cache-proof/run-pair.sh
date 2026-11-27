#!/usr/bin/env bash
set -euo pipefail
: "${BASE_SHA:?}" "${CANDIDATE_SHA:?}" "${EVIDENCE:?}"
mkdir -p "$EVIDENCE"
selections=(blind cache-prefix)
blind=(src/agents/system-prompt.blind.test.ts)
prefix=(src/agents/system-prompt.cache-prefix.test.ts src/agents/agent-tools.prefix-stability.test.ts)
[[ ${#selections[@]} == 2 && ${#blind[@]} == 1 && ${#prefix[@]} == 2 ]]
export OPENCLAW_VITEST_RUNTIME=node
printf '%s\n' "$BASE_SHA" "$CANDIDATE_SHA" > "$EVIDENCE/expected-pins.txt"
node --version > "$EVIDENCE/node-version.txt"
corepack pnpm --version > "$EVIDENCE/pnpm-version.txt"
free -b > "$EVIDENCE/memory.txt"
: > "$EVIDENCE/exits.jsonl"
run_selection() {
  local side=$1 selection=$2
  shift 2
  local start end status tee_status
  start=$(date +%s%3N)
  set +e
  corepack pnpm test "$@" --maxWorkers=1 2>&1 | tee "$EVIDENCE/$side-$selection.log"
  local pipeline=("${PIPESTATUS[@]}")
  set -e
  status=${pipeline[0]}
  tee_status=${pipeline[1]}
  end=$(date +%s%3N)
  printf '{"side":"%s","selection":"%s","exit":%s,"teeExit":%s,"elapsedMs":%s}\n' "$side" "$selection" "$status" "$tee_status" "$((end-start))" | tee -a "$EVIDENCE/exits.jsonl"
  [[ "$tee_status" == 0 ]]
  LAST_TEST_EXIT=$status
}
for side in base candidate; do
  if [[ "$side" == base ]]; then sha=$BASE_SHA; else sha=$CANDIDATE_SHA; fi
  git checkout --detach "$sha"
  [[ $(git rev-parse HEAD) == "$sha" ]]
  git diff --exit-code
  git status --porcelain=v1 > "$EVIDENCE/$side-status-before.txt"
  git rev-parse HEAD > "$EVIDENCE/$side-pin.txt"
  sha256sum src/agents/system-prompt-runtime.ts src/agents/system-prompt.blind.test.ts "${prefix[@]}" > "$EVIDENCE/$side-source.sha256"
  run_selection "$side" blind "${blind[@]}"
  if [[ "$side" == candidate && "$LAST_TEST_EXIT" != 0 ]]; then
    printf '%s\n' 'STOP: candidate blind selection failed; no repair or rerun.' | tee "$EVIDENCE/STOP.txt"
    exit 1
  fi
  run_selection "$side" cache-prefix "${prefix[@]}"
  git diff --exit-code
  git status --porcelain=v1 > "$EVIDENCE/$side-status-after.txt"
done
python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
r=Path(os.environ['EVIDENCE']);rows=[json.loads(x) for x in (r/'exits.jsonl').read_text().splitlines()]
assert [(x['side'],x['selection']) for x in rows]==[('base','blind'),('base','cache-prefix'),('candidate','blind'),('candidate','cache-prefix')]
v={'rows':rows,'allActualExitsZero':all(x['exit']==0 and x['teeExit']==0 for x in rows)}
(r/'verdict.json').write_text(json.dumps(v,indent=2)+'\n')
(r/'sha256.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in r.iterdir() if p.is_file() and p.name!='sha256.json'},indent=2)+'\n')
print(json.dumps(v,indent=2));assert v['allActualExitsZero']
PY
