import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Synthetic profiles never read or write the user's Keychain. */
export function syntheticChromeBinary(dir:string,chromium:string){
  mkdirSync(dir,{recursive:true,mode:0o700});
  const binary=join(dir,"synthetic-chrome"),quoted=`'${chromium.replace(/'/g,"'\\''")}'`;
  writeFileSync(binary,`#!/bin/sh\nexec ${quoted} --use-mock-keychain "$@"\n`,{mode:0o700});
  return binary;
}
