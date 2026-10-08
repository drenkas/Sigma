import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type TranscriptContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function streamDemo(model:Model<any>,context:TranscriptContext,options?:SimpleStreamOptions){
  const stream=createAssistantMessageEventStream();
  void (async()=>{
    const last=[...context.messages].reverse().find(m=>m.role==="user");
    const input=last?.role==="user"?(typeof last.content==="string"?last.content:last.content.filter(p=>p.type==="text").map(p=>p.text).join("")):"";
    const prompt=input.match(/^Role: \w+\. Task: ([\s\S]*)\nReturn a concise result and state what you verified\.$/)?.[1]??input;
    const result=context.messages.at(-1),hasResult=result?.role==="toolResult";
    const output:AssistantMessage={role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"pending",timestamp:Date.now()};
    stream.push({type:"start",partial:output});
    try{
      if(prompt==="fail-provider"||prompt.includes("Task: fail-provider")){
        output.stopReason="error";output.errorMessage="Offline simulated provider failure";
        stream.push({type:"error",reason:"error",error:output});return;
      }
      // Offline QA scripts: `script:[{name,arguments}]` runs one tool call per turn; "$observationId", "$artifactIds", "$assertIds" and "$failedAssertIds" resolve from earlier tool results of this turn sequence.
      const lastUser=context.messages.map(m=>m.role).lastIndexOf("user"),followUps=context.messages.slice(lastUser+1).filter(m=>m.role==="toolResult");
      const textOf=(m:typeof followUps[number])=>m.content.filter(p=>p.type==="text").map(p=>(p as {text:string}).text).join("");
      const reviewArtifact=prompt.match(/QA artifacts for review[^\n]*\n- artifact (\S+)/)?.[1];
      const script=prompt.startsWith("script:")?JSON.parse(prompt.slice(7)) as Array<{name:string;arguments:Record<string,unknown>}>:undefined;
      const next=script&&followUps.length<script.length&&!followUps.some(m=>m.isError)?script[followUps.length]:reviewArtifact&&!followUps.length?{name:"qa_view_artifact",arguments:{artifactId:reviewArtifact}}:undefined;
      if(next){
        const parsed=followUps.map(m=>{try{return JSON.parse(textOf(m)) as Record<string,any>;}catch{return {};}});
        const scope={$observationId:[...parsed].reverse().find(x=>x.observationId)?.observationId,$artifactIds:parsed.filter(x=>x.artifactId).map(x=>x.artifactId),$assertIds:parsed.filter(x=>x.outcome).map(x=>x.actionId),$failedAssertIds:parsed.filter(x=>x.outcome==="fail").map(x=>x.actionId)} as Record<string,unknown>;
        const resolved=Object.fromEntries(Object.entries(next.arguments).map(([key,value])=>[key,typeof value==="string"&&value in scope?scope[value]:value]));
        const tool={type:"toolCall" as const,id:randomUUID(),name:next.name,arguments:resolved as Record<string,never>};output.content.push(tool);
        stream.push({type:"toolcall_start",contentIndex:0,partial:output});stream.push({type:"toolcall_end",contentIndex:0,toolCall:tool,partial:output});
        output.stopReason="toolUse";stream.push({type:"done",reason:"toolUse",message:output});return;
      }
      if((prompt.startsWith("read:")||prompt.startsWith("delegate:" )||prompt.startsWith("delegate2:")||prompt.startsWith("repo2:")||prompt.startsWith("repo:")||prompt.startsWith("repo-status:")||/^(edit|write|bash|qa_\w+):/.test(prompt)||prompt.startsWith("delegate-qa:"))&&!hasResult){
        const mutation=prompt.match(/^(edit|write|bash|qa_\w+):([\s\S]*)$/);
        const calls=prompt.startsWith("delegate-qa:")?[{name:"delegate",arguments:{role:"qa",task:prompt.slice(12).trim()}}]:mutation?[{name:mutation[1],arguments:JSON.parse(mutation[2])}]:prompt.startsWith("read:")?[{name:"read",arguments:{path:prompt.slice(5).trim()}}]:prompt.startsWith("repo2:")?prompt.slice(6).split("|").slice(0,2).map(repositoryId=>({name:"delegate_repo",arguments:{repositoryId:repositoryId.trim(),task:"hello"}})):prompt.startsWith("repo:")?[{name:"delegate_repo",arguments:{repositoryId:prompt.slice(5).trim(),task:"hello"}}]:prompt.startsWith("repo-status:")?[{name:"repo_status",arguments:{repositoryId:prompt.slice(12).trim()}}]:prompt.startsWith("delegate2:")?prompt.slice(10).split("|").slice(0,2).map(task=>({name:"delegate",arguments:{role:"worker",task:task.trim()}})):[{name:"delegate",arguments:{role:"researcher",task:prompt.slice(9).trim()}}];
        for(const call of calls){const tool={type:"toolCall" as const,id:randomUUID(),...call};const index=output.content.length;output.content.push(tool);stream.push({type:"toolcall_start",contentIndex:index,partial:output});stream.push({type:"toolcall_end",contentIndex:index,toolCall:tool,partial:output});}
        output.stopReason="toolUse";stream.push({type:"done",reason:"toolUse",message:output});return;
      }
      output.content.push({type:"text",text:""});stream.push({type:"text_start",contentIndex:0,partial:output});
      const viewed=result?.role==="toolResult"&&result.toolName==="qa_view_artifact"&&!result.isError?textOf(result):"";
      const reply=viewed?`Reviewer verdict: PASS. Inspected QA artifact ${(()=>{try{return JSON.parse(viewed).artifactId;}catch{return "unknown";}})()} at the reviewed revision; no issue found.`:script&&followUps.length>=script.length&&!followUps.some(m=>m.isError)?`Demo QA script finished after ${script.length} steps.`:hasResult?(result?.role==="toolResult"&&result.isError?"Demo: a tool was denied or failed.":result?.role==="toolResult"&&result.toolName==="delegate"?"Demo: delegation returned; inspect the agent tree.":`Demo: the ${result?.role==="toolResult"?result.toolName:"read"} tool completed.`):`Demo response: ${prompt}`;
      for(const char of reply){
        if(options?.signal?.aborted){output.stopReason="aborted";stream.push({type:"error",reason:"aborted",error:output});return;}
        (output.content[0] as {type:"text";text:string}).text+=char;
        stream.push({type:"text_delta",contentIndex:0,delta:char,partial:output});
        if(prompt.startsWith("slow")||prompt.includes("Task: slow"))await new Promise(r=>setTimeout(r,30));
      }
      stream.push({type:"text_end",contentIndex:0,content:reply,partial:output});output.stopReason="stop";stream.push({type:"done",reason:"stop",message:output});
    }catch{output.stopReason="error";stream.push({type:"error",reason:"error",error:output});}
    finally{stream.end();}
  })();
  return stream;
}
export function registerDemoProvider(runtime:ModelRuntime){
  runtime.registerProvider("sigma-demo",{api:"sigma-demo",baseUrl:"http://127.0.0.1/unused",apiKey:"local-demo",streamSimple:streamDemo,models:[{id:"offline",name:"Offline demonstration",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:16384,maxTokens:1024}]});
}
