import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {mkdir,readFile,writeFile,stat} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
const exec=promisify(execFile),MARKER=".sigma-scratch";
export const scratchRoot=()=>process.env.SIGMA_SCRATCH_ROOT||join(homedir(),"Documents","Sigma");
const slugFor=(id:string,attempt:number)=>{const n=createHash("sha256").update(`${id}\0${attempt}`).digest().readUIntBE(0,5);return n.toString(36).padStart(3,"0").slice(-3);};
const localDate=(now:Date)=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
// Fresh scratch folder ~/Documents/Sigma/<YYYY-MM-DD>/<slug> for a project-less chat. The slug derives from the command id; a folder already
// claimed by this id (marker file) is reused, a folder owned by anything else is skipped. Returns a git root with one empty commit, because Parallel/Code sessions require one.
export async function createScratchDir(id:string,now=new Date()):Promise<string>{
  const day=join(scratchRoot(),localDate(now));await mkdir(day,{recursive:true,mode:0o700});
  for(let attempt=0;attempt<64;attempt++){
    const dir=join(day,slugFor(id,attempt));
    try{await mkdir(dir,{mode:0o700});await writeFile(join(dir,MARKER),id,{mode:0o600});}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;if((await readFile(join(dir,MARKER),"utf8").catch(()=>""))!==id)continue;}
    const git=(...args:string[])=>exec("git",["-c","core.hooksPath=/dev/null","-c","user.name=Sigma","-c","user.email=sigma@localhost","-c","commit.gpgsign=false",...args],{cwd:dir});
    if(!(await stat(join(dir,".git")).catch(()=>null))){await git("init","-q");await git("add","--",MARKER);await git("commit","-q","-m","Start chat");}
    return dir;
  }
  throw new Error("Cannot allocate a scratch folder");
}
