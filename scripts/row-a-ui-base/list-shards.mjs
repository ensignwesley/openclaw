import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(process.cwd()+'/package.json');
const {createVitest}=await import(pathToFileURL(require.resolve('vitest/node')).href);
const out=process.env.RECEIPTS;
for(const [name,config,shard,workers] of [['checks-ui','ui/vitest.config.ts','2/3',3],['checks-ui-e2e','test/vitest/vitest.ui-e2e.config.ts','12/12',2]]){
 const vitest=await createVitest({config,configLoader:'runner',watch:false,maxWorkers:workers,shard});
 try{
  const sequencer=new vitest.config.sequence.sequencer(vitest);
  const files=await sequencer.shard(await vitest.globTestSpecifications());
  fs.writeFileSync(out+'/'+name+'-shard-list.json',JSON.stringify({config,shard,workers,files:files.map(f=>({moduleId:f.moduleId,project:f.project?.name}))},null,2));
 }finally{await vitest.close();}
}
