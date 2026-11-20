import os,sys,json,pathlib,subprocess,time,signal,tempfile,shutil,hashlib
out=pathlib.Path(os.environ['RECEIPTS']);out.mkdir(parents=True,exist_ok=True)
repo=pathlib.Path.cwd();head=os.environ['PRODUCT'];base=os.environ['BASE'];deadline=time.monotonic()+210*60
harness=pathlib.Path(__file__).parent
files={rt:(harness/('files-'+rt+'.txt')).read_text().splitlines() for rt in ['node','bun']}
assert len(files['node'])==58 and len(files['bun'])==37
root=pathlib.Path(tempfile.mkdtemp(prefix='row-a-failing-files-'));rows=[]
(out/'invocation-root.txt').write_text(str(root));(out/'pins.json').write_text(json.dumps({'candidate':head,'base':base,'runner':os.environ.get('RUNNER_NAME'),'sharedRoot':str(root),'perFileTimeoutSeconds':180,'scriptBudgetMinutes':210}))
def save(): (out/'results.json').write_text(json.dumps(rows,indent=2))
def run(side,rt,file):
    ident=hashlib.sha256((rt+':'+file).encode()).hexdigest()[:16];dest=out/side/rt/ident;dest.mkdir(parents=True,exist_ok=True)
    (dest/'file.txt').write_text(file);(dest/'owner-head.txt').write_text(subprocess.check_output(['git','rev-parse','HEAD'],text=True))
    env={**os.environ,'OPENCLAW_VITEST_RUNTIME':rt,'TMPDIR':str(root),'TMP':str(root),'TEMP':str(root),'ROW_A_INVOCATION_ROOT':str(root),'ROW_A_PROMPT_CAPTURE':str(dest/'system-prompts.jsonl')}
    cwd=repo;cmd=['node','scripts/run-vitest.mjs',file,'--maxWorkers=1']
    if file.startswith('ui/'):
        cwd=repo/'ui';cmd=['corepack','pnpm','exec','vitest','run',file[3:],'--config','vitest.config.ts','--maxWorkers=1']
    started=time.monotonic();limit=min(180,max(0,deadline-started-30))
    status='not-run-budget-exhausted';code=None
    if limit>1:
        with (dest/'actual.log').open('wb') as log:
            p=subprocess.Popen(cmd,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                code=p.wait(timeout=limit);status='passed' if code==0 else 'failed'
            except subprocess.TimeoutExpired:
                status='timeout';os.killpg(p.pid,signal.SIGTERM)
                try:p.wait(timeout=3)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
                code=124
            finally:
                # The process owns a session; cleanup descendants even after parent exit.
                try:os.killpg(p.pid,signal.SIGKILL)
                except ProcessLookupError:pass
    row={'side':side,'runtime':rt,'file':file,'status':status,'exit':code,'seconds':time.monotonic()-started,'command':cmd,'cwd':str(cwd),'receipt':str(dest.relative_to(out))}
    rows.append(row);(dest/'exit.json').write_text(json.dumps(row,indent=2));save();print(json.dumps(row),flush=True)
    return row
worker='src/gateway/worker-environments/worker-turn-launcher-remote-handoff.test.ts'
def checkout(pin,side):
    subprocess.run(['git','checkout','--detach',pin],check=True)
    assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==pin
    (out/(side+'-checkout.txt')).write_text('CHECKOUT_SHA='+pin+'\n')
    # Proof-only diagnostic instrumentation, identical on both sides; no assertion/product edits.
    p=repo/worker;s=p.read_text();needle='    const systemPrompt = assignment.systemPrompt;'
    assert s.count(needle)==1
    injection='\n    if (process.env.ROW_A_PROMPT_CAPTURE) {\n      (await import("node:fs")).appendFileSync(process.env.ROW_A_PROMPT_CAPTURE, JSON.stringify({ systemPrompt }) + "\\n");\n    }'
    p.write_text(s.replace(needle,needle+injection));(out/(side+'-instrumentation.diff')).write_bytes(subprocess.check_output(['git','diff','--',worker]))
try:
    checkout(head,'candidate')
    pending=[]
    for rt in ['node','bun']:
        for file in files[rt]:
            row=run('candidate',rt,file)
            if row['status']!='passed':pending.append((rt,file))
    subprocess.run(['git','restore','--',worker],check=True)
    checkout(base,'base')
    # Identical lockfile means the exact same installed dependencies remain in place.
    for path in ['pnpm-lock.yaml','package.json']:
        a=subprocess.check_output(['git','show',head+':'+path]);b=subprocess.check_output(['git','show',base+':'+path]);assert a==b,path
    for rt,file in pending:run('base',rt,file)
    subprocess.run(['git','restore','--',worker],check=True)
    classified={'failsBoth':[],'candidateOnly':[],'passesAloneCandidate':[],'incomplete':[]}
    for c in [r for r in rows if r['side']=='candidate']:
        b=next((r for r in rows if r['side']=='base' and r['runtime']==c['runtime'] and r['file']==c['file']),None)
        item={'runtime':c['runtime'],'file':c['file'],'candidate':c,'base':b}
        key='passesAloneCandidate' if c['status']=='passed' else 'incomplete' if c['status']=='not-run-budget-exhausted' or not b or b['status']=='not-run-budget-exhausted' else 'candidateOnly' if b['status']=='passed' else 'failsBoth'
        classified[key].append(item)
    (out/'classification.json').write_text(json.dumps(classified,indent=2));save()
    sys.exit(2 if classified['incomplete'] else 0)
finally:
    # Only this invocation created this root.
    shutil.rmtree(root);(out/'root-cleanup.txt').write_text('owner removed '+str(root)+'\n')
