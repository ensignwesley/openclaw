"""Fork-only exact-head proof; no original regression/assertion edits."""
import json
import os
import re
from pathlib import Path
import subprocess

BASE = '22bc1d2495d86547de8f533be5aad3b0f07c0a68'
CANDIDATE = 'a5882d6834596a9a6c615cbf35d8b67c27511fde'
OUT = Path(os.environ['RUNNER_TEMP']) / 'e1-completion-proof'
OUT.mkdir(exist_ok=True)
COMPLETION = 'src/agents/cli-runner/prepare.completion-tools.test.ts'

def run(label, command, expected=0, extra_env=None):
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=1200, env={**os.environ, **(extra_env or {})})
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
raw_errors = OUT / 'baseline-errors.jsonl'
raw_errors.write_text('')
run('baseline', ['node', 'scripts/run-vitest.mjs', COMPLETION, '--maxWorkers=1', '--', '--reporter=json', '--reporter=' + str(Path(os.environ['RUNNER_TEMP']) / 'completion-errors.mjs'), '--outputFile', str(OUT / 'baseline.json')], expected=1, extra_env={'E1_BASELINE_ERRORS': str(raw_errors)})
report = json.loads((OUT / 'baseline.json').read_text())
assert report['numTotalTests'] == 33 and report['numPassedTests'] == 31 and report['numFailedTests'] == 2
failures = [a for s in report['testResults'] for a in s['assertionResults'] if a['status'] == 'failed']
assert len(failures) == 2
observed = [json.loads(line) for line in raw_errors.read_text().splitlines()]
assert len(observed) == 2
assert sorted(item['name'] for item in observed) == sorted(item['title'] for item in failures)
for failure, owner in zip(sorted(failures, key=lambda a: a['fullName']), ['false', 'undefined']):
    assert 'keeps the CLI catalog stable while gating persisted completion authority with owner=' + owner in failure['fullName']
    message = '\n'.join(failure['failureMessages'])
    assert COMPLETION + ':907:28' in message
    captured = next(item for item in observed if item['name'] == failure['title'])
    assert captured['state'] == 'failed' and len(captured['errors']) == 1
    error = captured['errors'][0]
    assert error['name'] == 'AssertionError' and COMPLETION + ':907:28' in error['stack']
    assert isinstance(error['actual'], str) and isinstance(error['expected'], str)
    for field in ['background', 'durable', 'yieldMs']:
        property_line = r'(?m)^\s*["\x27]?' + field + r'["\x27]?\s*:'
        assert re.search(property_line, error['expected'])
        assert not re.search(property_line, error['actual'])
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
