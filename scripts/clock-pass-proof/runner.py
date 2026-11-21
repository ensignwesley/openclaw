import os,sys,json,pathlib,subprocess,time,signal,tempfile,shutil,hashlib
out=pathlib.Path(os.environ['RECEIPTS']);out.mkdir(parents=True,exist_ok=True)
repo=pathlib.Path.cwd();head=os.environ['PRODUCT'];base=os.environ['BASE'];harness=pathlib.Path(__file__).parent
root=pathlib.Path(tempfile.mkdtemp(prefix='clock-pass-paired-'));rows=[]
(out/'pins.json').write_text(json.dumps({'candidate':head,'base':base,'runner':os.environ.get('RUNNER_NAME'),'sharedRoot':str(root),'sideTimeoutSeconds':1200}))
files=['src/logging/redact-patterns.test.ts','src/logging/redact-byte-identity.test.ts','src/logging/redact.test.ts']
def invoke(side,name,cmd,limit):
 dest=out/side;dest.mkdir(exist_ok=True);start=time.monotonic()
 env={**os.environ,'OPENCLAW_VITEST_RUNTIME':'node','TMPDIR':str(root),'TMP':str(root),'TEMP':str(root),'ROW_A_INVOCATION_ROOT':str(root),'CLOCK_SIDE':side,'CLOCK_OUTPUT':str(dest/'api.json')}
 with (dest/(name+'.log')).open('wb') as log:
  p=subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(timeout=limit);status='passed' if code==0 else 'failed'
  except subprocess.TimeoutExpired:
   status='timeout';os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=3)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   code=124
  finally:
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
 row={'side':side,'name':name,'exit':code,'status':status,'seconds':time.monotonic()-start,'command':cmd};rows.append(row);(dest/(name+'.exit.json')).write_text(json.dumps(row,indent=2));print(json.dumps(row),flush=True)
 return row
try:
 for side,pin in [('base',base),('candidate',head)]:
  subprocess.run(['git','checkout','--detach',pin],check=True)
  assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==pin
  dest=out/side;dest.mkdir(exist_ok=True);(dest/'owner-head.txt').write_text('CHECKOUT_SHA='+pin+'\n')
  before=hashlib.sha256((repo/'src/logging/redact-patterns.ts').read_bytes()).hexdigest()
  # Same candidate regression tests on the base; no product overlay.
  p=repo/files[0];original=p.read_bytes();p.write_bytes((harness/'redact-patterns.test.ts').read_bytes())
  (dest/'test-hash.txt').write_text(hashlib.sha256(p.read_bytes()).hexdigest())
  api=invoke(side,'controls-and-corpus',['node','--import','./scripts/tsx.mjs',str(harness/'api.ts')],180)
  tests=invoke(side,'owning-three-files',['node','scripts/run-vitest.mjs',*files,'--maxWorkers=1','--reporter=json','--outputFile='+str(dest/'vitest-report.json')],1200)
  p.write_bytes(original)
  after=hashlib.sha256((repo/'src/logging/redact-patterns.ts').read_bytes()).hexdigest();assert before==after
  (dest/'product-hash.json').write_text(json.dumps({'before':before,'after':after}))
  assert api['exit']==0,'API controls/corpus qualification failed'
  report=json.loads((dest/'vitest-report.json').read_text())
  failures=[a for t in report['testResults'] for a in t['assertionResults'] if a['status']=='failed']
  (dest/'failures.json').write_text(json.dumps(failures,indent=2))
  if side=='base':
   assert tests['exit']!=0 and len(failures)==6
   assert all('keeps clock- and grep-prefixed prose intact:' in f['fullName'] for f in failures)
  else:assert tests['exit']==0 and report['numFailedTests']==0
 (out/'qualification.json').write_text(json.dumps({'qualified':True,'baseExpectedFailures':6,'candidateFailures':0,'controlsPerSide':11,'byteIdentitySamplesPerSide':250,'sameRunnerAndRoot':True,'productOverlays':False},indent=2))
finally:
 (out/'actual-exits.json').write_text(json.dumps(rows,indent=2));shutil.rmtree(root);(out/'root-cleanup.txt').write_text('owner removed '+str(root)+'\n')
