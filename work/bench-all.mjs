import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const results=[];
for(const runtime of ["node","bun"]){
  for(const agents of [1,4,8])for(const rate of [200,1000])for(let repeat=1;repeat<=3;repeat++){
    const run=spawnSync(runtime,["work/bench.mjs",String(agents),String(rate)],{encoding:"utf8",timeout:10000});
    if(run.status!==0)throw new Error(`${runtime} ${agents}/${rate} failed: ${run.stderr.slice(0,300)}`);
    results.push({...JSON.parse(run.stdout),repeat});
  }
}
writeFileSync("work/bench-results.json",JSON.stringify({platform:process.platform,arch:process.arch,host:"MacBookPro18,1",repeats:3,results},null,2));
const summary=[];
for(const runtime of ["node","bun"])for(const agents of [1,4,8])for(const rate of [200,1000]){
  const subset=results.filter(x=>x.runtime===runtime&&x.agents===agents&&x.rate===rate);
  const median=key=>subset.map(x=>x[key]).sort((a,b)=>a-b)[1];
  summary.push({runtime,agents,rate,dispatchP95Ms:median("dispatchP95Ms"),loopLagP95Ms:median("loopLagP95Ms"),rssMiB:median("rssAfterMiB"),cpuMs:median("cpuMs")});
}
console.log(JSON.stringify(summary,null,2));
