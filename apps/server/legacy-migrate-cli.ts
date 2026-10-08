import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { capture, defaultStageRoot, journalState, listStages, stage } from "./legacy-migration.js";

// Preview/stage never write to the destination; publishing happens at server startup (SIGMA_MIGRATE_PUBLISH=<stageId>).
const { positionals:[command],values } = parseArgs({allowPositionals:true,options:{source:{type:"string",multiple:true},dest:{type:"string"},"stage-root":{type:"string"},authorize:{type:"string"},"accept-alias":{type:"string",multiple:true},"accept-missing-history":{type:"string",multiple:true}}});
const dest=resolve(values.dest??process.env.SIGMA_DATA_DIR??process.env.PI_ORCH_DATA_DIR??join(homedir(),"Library/Application Support/dev.sigma.app"));
const stageRoot=resolve(values["stage-root"]??process.env.SIGMA_MIGRATION_STAGE??defaultStageRoot(dest));
const list=(items?:string[])=>(items??[]).flatMap(item=>item.split(",")).filter(Boolean);
try{
  if(command==="status"){console.log(JSON.stringify({destination:dest,journal:journalState(dest),stages:listStages(stageRoot)},null,2));}
  else if(command==="preview"||command==="stage"){
    if(values.source?.length!==1)throw new Error("Pass exactly one --source directory; sources are never merged");
    const options={source:values.source[0],dest,stageRoot};
    if(command==="preview"){
      const result=await capture(options);
      console.log(`Stage ${result.stageId} (${result.state})\nReport SHA-256: ${result.reportSha256}\nReport: ${join(result.dir,"preview.md")}\nBlockers: ${result.report.blockers.length}, warnings: ${result.report.warnings.length}`);
      for(const blocker of result.report.blockers)console.log(`  blocker ${blocker.kind}${blocker.session?` ${blocker.session}`:""}: ${blocker.detail}`);
      for(const warning of result.report.warnings)console.log(`  warning: ${warning}`);
    }else{
      if(!values.authorize)throw new Error("Pass --authorize <report SHA-256> from a reviewed preview");
      const result=await stage({...options,authorize:values.authorize,acceptAlias:list(values["accept-alias"]),acceptMissingHistory:list(values["accept-missing-history"])});
      console.log(`Staged ${result.stageId}. Stop Sigma, then start it with SIGMA_MIGRATE_PUBLISH=${result.stageId} SIGMA_DATA_DIR=${dest}${process.env.SIGMA_MIGRATION_STAGE?` SIGMA_MIGRATION_STAGE=${stageRoot}`:""}`);
    }
  }else throw new Error("Usage: preview|stage|status --source <dir> [--dest <dir>] [--stage-root <dir>] [--authorize <sha256>] [--accept-alias <ids>] [--accept-missing-history <ids>]");
}catch(error){console.error((error as Error).message);process.exitCode=1;}
