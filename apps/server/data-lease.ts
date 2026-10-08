import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

function descriptor(path:string,directory:boolean,variable:string){
  const inherited=process.env[variable];let fd:number|undefined,owned=false;
  try{
    if(inherited!==undefined){
      if(!/^[0-9]+$/.test(inherited)||!Number.isSafeInteger(Number(inherited))||Number(inherited)<3)throw new Error("Invalid inherited DATA_DIR lease");
      fd=Number(inherited);
    }else{
      fd=openSync(path,constants.O_NOFOLLOW|(directory?constants.O_RDONLY|constants.O_DIRECTORY:constants.O_CREAT|constants.O_RDWR),0o600);owned=true;
    }
    const opened=fstatSync(fd),named=lstatSync(path);
    const valid=(info:ReturnType<typeof fstatSync>)=>directory?info.isDirectory():info.isFile()&&info.nlink===1;
    if(!valid(opened)||!valid(named)||opened.dev!==named.dev||opened.ino!==named.ino)throw new Error("Invalid DATA_DIR lease identity");
    if(inherited!==undefined){
      // Darwin /dev/fd duplicates the same open description. uv's open sets
      // CLOEXEC on the new FD, so unrelated subprocesses cannot retain it.
      const adopted=openSync(`/dev/fd/${fd}`,directory?constants.O_RDONLY:constants.O_RDWR);
      closeSync(fd);fd=adopted;owned=true;delete process.env[variable];
    }
    // Use the system Perl flock builtin, available on macOS 13.5 where
    // lockf(1) lacks descriptor-only mode. No shell, paths or credentials.
    // Utility exit closes only its duplicate; our FD retains the kernel lock.
    const result=spawnSync("/usr/bin/perl",["-e","flock(STDIN, 6) or exit($!{EWOULDBLOCK} ? 75 : 1)"],{stdio:[fd,"ignore","ignore"],env:{},timeout:5000});
    if(result.status===75)throw new Error("DATA_DIR is already owned by another Sigma process. Use a different SIGMA_DATA_DIR.");
    if(result.error||result.status!==0)throw new Error("DATA_DIR lease could not be acquired; system flock is unavailable");
    const current=lstatSync(path);
    if(!valid(current)||current.dev!==opened.dev||current.ino!==opened.ino)throw new Error("DATA_DIR lease identity changed");
    fchmodSync(fd,directory?0o700:0o600);return fd;
  }catch(error){if(fd!==undefined&&owned)closeSync(fd);throw error;}
}

// The directory inode is the stable owner boundary even when Git removes a
// tracked sigma.lock. Retain the file lock for pre-F3 native compatibility.
// All launches acquire directory -> file and close (never LOCK_UN) after drain.
export class DataLease {
  private constructor(readonly directory:string,private fds:number[]){}
  static async acquire(directory:string){
    await mkdir(directory,{recursive:true,mode:0o700});
    directory=await realpath(directory);
    const fds:number[]=[];
    try{
      fds.push(descriptor(directory,true,"SIGMA_DATA_DIR_LOCK_FD"));
      fds.push(descriptor(join(directory,"sigma.lock"),false,"SIGMA_DATA_LOCK_FD"));
      await chmod(directory,0o700);return new DataLease(directory,fds);
    }catch(error){for(const fd of fds.reverse())closeSync(fd);throw error;}
  }
  // Read-only owner check for a directory we must not modify: never creates or chmods anything.
  static probe(directory:string):"held"|"free"{
    const test=(fd:number)=>{const result=spawnSync("/usr/bin/perl",["-e","flock(STDIN, 6) or exit($!{EWOULDBLOCK} ? 75 : 1)"],{stdio:[fd,"ignore","ignore"],env:{},timeout:5000});if(result.status===75)return "held" as const;if(result.error||result.status!==0)throw new Error("DATA_DIR probe could not run system flock");return "free" as const;};
    const targets=[[directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW],[join(directory,"sigma.lock"),constants.O_RDONLY|constants.O_NOFOLLOW]] as const;
    for(const [path,flags] of targets){
      let fd:number;try{fd=openSync(path,flags);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"&&path!==directory)continue;throw error;}
      try{if(test(fd)==="held")return "held";}finally{closeSync(fd);}
    }
    return "free";
  }
  close(){for(const fd of this.fds.splice(0).reverse())closeSync(fd);}
}
