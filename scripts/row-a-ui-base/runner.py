import os,sys,json,pathlib,subprocess,time,signal,tempfile,shutil,hashlib
out=pathlib.Path(os.environ['RECEIPTS']);out.mkdir(parents=True,exist_ok=True);repo=pathlib.Path.cwd();base=os.environ['BASE'];harness=pathlib.Path(__file__).parent
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==base
(out/'owner-head.txt').write_text('CHECKOUT_SHA='+base+'\n')
root=pathlib.Path(tempfile.mkdtemp(prefix='ui-base-invocation-'));started=time.monotonic();deadline=started+70*60;rows=[]
configs=['.github/workflows/ci.yml','ui/vitest.config.ts','test/vitest/vitest.ui-e2e.config.ts','config/control-ui-startup-budget-baseline.json','scripts/check-control-ui-performance-base.mts','scripts/check-control-ui-performance.mts','scripts/ci-run-node-test-shard.mts']
for name in configs:
 p=repo/name
 if p.exists():
  target=out/'configs'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
(out/'settings.json').write_text(json.dumps({'base':base,'runner':os.environ.get('RUNNER_NAME'),'sharedRoot':str(root),'jobLabel':'checks-ui-e2e (12/13)','actualE2EVitestShard':'12/12','uiShard':'2/3','uiPolicy':'dual-all','groupsGzipBase64':'','uiWorkers':3,'e2eWorkers':2,'noCandidate':True},indent=2))
def invoke(name,cmd,seconds,extra=None):
 env={**os.environ,'TMPDIR':str(root),'TMP':str(root),'TEMP':str(root),'OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY':'1','OPENCLAW_UI_E2E_SKIP_PRODUCTION_ARTIFACT':'0',**(extra or {})}
 (out/(name+'.env.json')).write_text(json.dumps(extra or {},indent=2))
 limit=min(seconds,max(1,deadline-time.monotonic()-30));start=time.monotonic()
 with (out/(name+'.log')).open('wb') as log:
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
 row={'name':name,'exit':code,'status':status,'seconds':time.monotonic()-start,'timeoutSeconds':limit,'command':cmd};rows.append(row);(out/(name+'.exit.json')).write_text(json.dumps(row,indent=2));(out/'actual-exits.json').write_text(json.dumps(rows,indent=2));print(json.dumps(row),flush=True)
 return row
try:
 list_result=invoke('shard-lists',['node','--import','./scripts/tsx.mjs',str(harness/'list-shards.mjs')],300)
 # All three checks run even when a preceding check is red; no tee pipeline can erase exits.
 invoke('control-ui-performance',['corepack','pnpm','ui:check-performance:base',base],900)
 invoke('checks-ui-2-of-3',['node','--import','tsx','scripts/ci-run-node-test-shard.mts'],1800,{'OPENCLAW_CI_TEST_RUNTIME_POLICY':'dual-all','OPENCLAW_NODE_TEST_CONFIGS_JSON':'["ui/vitest.config.ts"]','OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64':'','OPENCLAW_NODE_TEST_PLAN_CONCURRENCY':'1','OPENCLAW_NODE_TEST_VITEST_ARGS_JSON':'["--maxWorkers","3","--reporter=verbose","--reporter=github-actions","--reporter=./scripts/lib/vitest-resource-reporter.mts","--shard=2/3"]','OPENCLAW_UI_E2E_DIAGNOSTIC_DIR':str(out/'diagnostics/ui'),'DEBUG':'vitest:browser:*,pw:browser'})
 invoke('checks-ui-e2e-label12-of13-actual12-of12',['node','scripts/run-vitest.mjs','run','--config','test/vitest/vitest.ui-e2e.config.ts','--configLoader','runner','--maxWorkers','2','--shard','12/12'],1200,{'VITEST_SHARD_INDEX':'12','VITEST_SHARD_COUNT':'12','OPENCLAW_VITEST_MAX_WORKERS':'2','OPENCLAW_UI_E2E_DIAGNOSTIC_DIR':str(out/'diagnostics/e2e')})
 (out/'terminal.json').write_text(json.dumps({'orchestratorComplete':True,'checks':[r for r in rows if r['name']!='shard-lists'],'shardListsSaved':list_result['exit']==0,'allActualExitsPreserved':True},indent=2))
finally:
 for name in ['dist/control-ui','ui/.artifacts','.artifacts/control-ui-e2e-timeouts']:
  p=repo/name
  if p.exists():shutil.copytree(p,out/'generated'/name,dirs_exist_ok=True)
 shutil.rmtree(root);(out/'root-cleanup.txt').write_text('owner removed '+str(root)+'\n')
