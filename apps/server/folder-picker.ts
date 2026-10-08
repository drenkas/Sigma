import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec=promisify(execFile);
// Fixed AppKit script: no request values or paths are interpolated into code.
const script=`
ObjC.import('AppKit');
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const panel = $.NSOpenPanel.openPanel;
panel.title = 'Choose project folders';
panel.message = 'Select folders for Sigma. Hold Command to select several.';
panel.prompt = 'Add folders';
panel.canChooseFiles = false;
panel.canChooseDirectories = true;
panel.allowsMultipleSelection = true;
panel.canCreateDirectories = false;
app.activateIgnoringOtherApps(true);
const paths = [];
if (panel.runModal === $.NSModalResponseOK) {
  for (let i = 0; i < panel.URLs.count; i++) paths.push(panel.URLs.objectAtIndex(i).path.js);
}
JSON.stringify(paths);
`;
let choosing=false;
export async function chooseFolders(signal:AbortSignal):Promise<string[]>{
  if(process.platform!=="darwin")throw Object.assign(new Error("The folder picker requires macOS"),{statusCode:501});
  if(choosing)throw Object.assign(new Error("A folder picker is already open"),{statusCode:409});
  choosing=true;
  try{
    const {stdout}=await exec("/usr/bin/osascript",["-l","JavaScript","-e",script],{signal,timeout:300_000,maxBuffer:128*1024});
    const folders:unknown=JSON.parse(stdout);
    if(!Array.isArray(folders)||!folders.every(path=>typeof path==="string"))throw new Error();
    return folders;
  }catch{
    throw new Error("Folder selection did not finish. Try Choose folders again.");
  }finally{choosing=false;}
}
