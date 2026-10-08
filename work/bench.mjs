import { performance } from "node:perf_hooks";

const agents=Number(process.argv[2]||1),rate=Number(process.argv[3]||200),durationMs=1500;
if(![1,4,8].includes(agents)||![200,1000].includes(rate))throw new Error("agents=1/4/8; rate=200/1000");
const startupMs=Math.round(process.uptime()*1000);
const history=Array.from({length:10000},(_,i)=>({agent:i%agents,role:i%2?"assistant":"user",text:`message-${i} ${"x".repeat(48)}`}));
const historyBytes=Buffer.byteLength(JSON.stringify(history));
const queues=Array.from({length:agents},()=>[]);
const delays=[],lags=[];let produced=0,processed=0;
const cpuBefore=process.cpuUsage(),rssBefore=process.memoryUsage().rss;
const started=performance.now();let expected=started+10;
await new Promise(resolve=>{
  const timer=setInterval(()=>{
    const now=performance.now();lags.push(Math.max(0,now-expected));expected=now+10;
    const target=Math.floor((now-started)*rate/1000);
    while(produced<target){const agent=produced%agents;queues[agent].push({at:performance.now(),payload:"d".repeat(32)});produced++;}
    for(const queue of queues){while(queue.length){const event=queue.shift();delays.push(performance.now()-event.at);processed++;}}
    if(now-started>=durationMs){clearInterval(timer);resolve();}
  },10);
});
const elapsedMs=performance.now()-started;
const cpu=process.cpuUsage(cpuBefore),rssAfter=process.memoryUsage().rss;
function percentile(values,p){values.sort((a,b)=>a-b);return Number((values[Math.min(values.length-1,Math.floor(values.length*p))]||0).toFixed(3));}
console.log(JSON.stringify({runtime:typeof Bun==="undefined"?"node":"bun",version:process.version,agents,rate,history:history.length,historyBytes,payloadBytes:32,produced,processed,elapsedMs:Number(elapsedMs.toFixed(1)),startupMs,dispatchP50Ms:percentile(delays,.5),dispatchP95Ms:percentile(delays,.95),loopLagP95Ms:percentile(lags,.95),rssBeforeMiB:Number((rssBefore/1048576).toFixed(1)),rssAfterMiB:Number((rssAfter/1048576).toFixed(1)),cpuMs:Number(((cpu.user+cpu.system)/1000).toFixed(1))}));
