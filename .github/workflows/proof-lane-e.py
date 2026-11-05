"""Fork-only, secretless exact-product before/after and diagnostic evidence."""
import hashlib,json,os,pathlib,re,subprocess,sys
root=pathlib.Path.cwd()
out=pathlib.Path(os.environ['LANE_E_OUTPUT']);out.mkdir(parents=True,exist_ok=True)
case=os.environ['LANE_E_CASE'];base=os.environ['LANE_E_BASE'];proof=os.environ['LANE_E_PROOF']
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
results=[]
def git(*args):return subprocess.check_output(['git',*args])
def run(label,cmd,red=None):
 print('START',label,flush=True)
 p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 (out/(label+'.log')).write_text(p.stdout)
 clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',p.stdout)
 (out/(label+'-clean.log')).write_text(clean)
 result={'label':label,'command':cmd,'exitCode':p.returncode}
 if red:
  filename,needle=red
  line=next(i for i,s in enumerate((root/filename).read_text().splitlines(),1) if needle in s)
  reached=p.returncode!=0 and 'AssertionError' in clean and (filename+':'+str(line)+':') in clean
  result.update(expectedAssertionFile=filename,expectedAssertionLine=line,reachedExpectedAssertion=reached)
  ok=reached
 else:ok=p.returncode==0
 results.append(result);(out/'gates.json').write_text(json.dumps(results,indent=2))
 print('END',label,p.returncode,'accepted',ok,flush=True)
 if not ok:
  print(p.stdout[-14000:],flush=True);raise SystemExit(1)
identity={'productHead':head,'base':base,'proofHead':proof,'case':case}
identity['tree']=git('rev-parse','HEAD^{tree}').decode().strip()
(out/'identity.json').write_text(json.dumps(identity,indent=2))
(out/'commit.txt').write_bytes(git('show','-s','--format=fuller','HEAD'))
(out/'changed.txt').write_bytes(git('diff','--name-status',base,'HEAD'))
test='src/agents/agent-tools.prefix-stability.test.ts' if case=='e1' else 'src/plugins/loader.async-preparation.test.ts'
if case in ('e1','e2'):
 owners=['src/agents/openclaw-tools.ts','src/agents/agent-tool-availability.ts','src/agents/agent-tools.turn-authority.ts'] if case=='e1' else ['src/plugins/prepared-message-tool-catalog.ts']
 for f in owners:(root/f).write_bytes(git('show',base+':'+f))
 needle='expect(surface(disabled))' if case=='e1' else 'expect(local.actions)'
 pattern='keeps message declarations and prompt bytes when execution is disabled for a turn' if case=='e1' else 'advertises identical channel message schemas before and after registry activation'
 run('baseline',['pnpm','test',test,'--maxWorkers=1','-t',pattern],(test,needle))
 for f in owners:(root/f).write_bytes(git('show','HEAD:'+f))
 assert not git('diff','--name-only').strip(),'product source must be exactly restored'
 tests=[test,'src/agents/agent-tool-availability.test.ts','src/agents/agent-tools.turn-authority.test.ts','src/agents/openclaw-tools.registration.test.ts'] if case=='e1' else [test,'src/plugins/prepared-message-tool-catalog.test.ts']
 run('candidate-focused',['pnpm','test',*tests,'--maxWorkers=1'])
 run('production-types',['pnpm','tsgo:core'])
 changed=git('diff','--name-only',base,'HEAD','--','*.ts').decode().splitlines()
 extra=['test/lane-e1-message-declaration.e2e.test.ts'] if case=='e1' else []
 typefiles=[f for f in changed+extra if f.endswith('.test.ts')]
 cfg=root/'test/tsconfig/tsconfig.lane-e-proof.json'
 cfg.write_text(json.dumps({'extends':'./tsconfig.core.test.shard.json','include':['../../'+f for f in typefiles],'exclude':[]}))
 try:run('changed-test-types',['node','scripts/run-tsgo.mjs','-p',str(cfg.relative_to(root))])
 finally:cfg.unlink(missing_ok=True)
 run('lint',['node','scripts/run-oxlint.mjs','--tsconfig','tsconfig.core.json',*changed,*extra])
 run('format',['pnpm','exec','oxfmt','--check',*changed,*extra])
 if case=='e1':
  run('gateway',['pnpm','test:e2e:gateway','test/lane-e1-message-declaration.e2e.test.ts'])
elif case=='screen':
 run('e6-custody-screen',['pnpm','test','src/auto-reply/reply/agent-runner-steer-adoption.worker.test.ts','--maxWorkers=1','-t','retains a parked steer through policy-read failure and outer source cleanup'])
 run('e9-origin-screen',['pnpm','test','src/channels/plugins/message-actions.test.ts','--maxWorkers=1','-t','screens non-Slack'])
elif case=='e5':
 run('e5-live-prefix-screen',['pnpm','test:e2e:gateway','test/lane-e5-live-input-prefix.e2e.test.ts'])
else:raise SystemExit('unknown case')
(out/'terminal.json').write_text(json.dumps({'case':case,'head':head,'allRequiredCommandsPassed':True,'limits':'No live provider, billing or cache-hit measurement.'},indent=2))
