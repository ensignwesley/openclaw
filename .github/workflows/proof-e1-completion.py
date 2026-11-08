"""Fork-only exact-head proof; no original regression/assertion edits."""
import json
import os
from pathlib import Path
import subprocess

BASE = '22bc1d2495d86547de8f533be5aad3b0f07c0a68'
CANDIDATE = 'a5882d6834596a9a6c615cbf35d8b67c27511fde'
OUT = Path(os.environ['RUNNER_TEMP']) / 'e1-completion-proof'
OUT.mkdir(exist_ok=True)
COMPLETION = 'src/agents/cli-runner/prepare.completion-tools.test.ts'

def run(label, command, expected=0):
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=1200)
    (OUT / (label + '.log')).write_text(result.stdout)
    print(result.stdout, flush=True)
    (OUT / (label + '.exit')).write_text(str(result.returncode))
    if result.returncode != expected:
        raise RuntimeError(f'{label}: exit {result.returncode}, expected {expected}')

def checkout(sha):
    run('checkout-' + sha[:8], ['git', 'checkout', '--detach', sha])
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    assert actual == sha
    (OUT / (sha[:8] + '.head')).write_text(actual)

checkout(BASE)
run('baseline', ['node', 'scripts/run-vitest.mjs', COMPLETION, '--maxWorkers=1', '--', '--reporter=json', '--outputFile', str(OUT / 'baseline.json')], expected=1)
report = json.loads((OUT / 'baseline.json').read_text())
assert report['numTotalTests'] == 33 and report['numPassedTests'] == 31 and report['numFailedTests'] == 2
failures = [a for s in report['testResults'] for a in s['assertionResults'] if a['status'] == 'failed']
assert len(failures) == 2
for failure, owner in zip(sorted(failures, key=lambda a: a['fullName']), ['false', 'undefined']):
    assert 'keeps the CLI catalog stable while gating persisted completion authority with owner=' + owner in failure['fullName']
    message = '\n'.join(failure['failureMessages'])
    assert all(field in message for field in ['background', 'durable', 'yieldMs'])
print('BASELINE_ACCEPTED: exactly the two reported existing schema assertions failed', flush=True)
checkout(CANDIDATE)
assert subprocess.check_output(['git', 'rev-parse', BASE + ':' + COMPLETION]) == subprocess.check_output(['git', 'rev-parse', CANDIDATE + ':' + COMPLETION])
run('fixed', ['node', 'scripts/run-vitest.mjs', COMPLETION, 'src/agents/agent-tools.turn-authority.test.ts', 'src/agents/agent-tools.prefix-stability.test.ts', '--maxWorkers=1', '--', '--reporter=json', '--outputFile', str(OUT / 'fixed.json')])
fixed = json.loads((OUT / 'fixed.json').read_text())
assert fixed['numTotalTests'] == 65 and fixed['numPassedTests'] == 65 and fixed['numFailedTests'] == 0
run('format', ['pnpm', 'exec', 'oxfmt', '--check', 'src/agents/lazy-exec-tool.ts'])
run('lint', ['pnpm', 'exec', 'oxlint', 'src/agents/lazy-exec-tool.ts'])
run('core-types', ['pnpm', 'tsgo:core'])
run('whitespace', ['git', 'diff', '--check', BASE, CANDIDATE])
(OUT / 'RESULT.json').write_text(json.dumps({'baseline': BASE, 'candidate': CANDIDATE, 'baselineAccepted': True, 'fixed65Passed': True, 'staticPassed': True}, indent=2) + '\n')
