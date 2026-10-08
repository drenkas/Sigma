import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function privateDirectory(path){const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error();}
function exactFields(value,fields){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==fields.sort().join(","))throw new Error();}
function privateFile(path,maxSize){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.size>maxSize)throw new Error();return readFileSync(fd);}
  finally{closeSync(fd);}
}
export const PINNED_BINARY_NAME="CLIProxyAPI-8.0.13",PINNED_BINARY_SHA256="1ad2a918f96cc4e8b3e9ea99f305efe4a4c10d11ecb2fc152273e129b6bef576";
/** `options.sha256` is a test seam only; production callers never pass it. */
export function readDeployment(dataDir,options){
  const data=resolve(dataDir),directory=join(data,"cliproxyapi"),auth=join(directory,"auth"),binary=join(directory,"bin",PINNED_BINARY_NAME);
  for(const path of [data,directory,auth,join(directory,"bin")])privateDirectory(path);
  const config=JSON.parse(privateFile(join(directory,"config.json"),65_536));
  const connection=JSON.parse(privateFile(join(directory,"connection.json"),16_384));
  // v8 grouped settings override legacy spellings. Accept only this owned
  // legacy schema so an additional field cannot bypass the checked guards.
  exactFields(config,["host","port","auth-dir","api-keys","remote-management","plugins","quota-exceeded","debug","logging-to-file","request-log","commercial-mode","usage-statistics-enabled","request-retry","max-retry-credentials","ws-auth"]);
  exactFields(connection,["baseUrl","apiKey"]);
  exactFields(config["remote-management"],["allow-remote","secret-key","disable-control-panel"]);
  exactFields(config.plugins,["enabled"]);
  exactFields(config["quota-exceeded"],["switch-project","switch-preview-model","antigravity-credits"]);
  if(config.host!=="127.0.0.1"||!Number.isInteger(config.port)||config.port<1024||config.port>65535||connection.baseUrl!==`http://127.0.0.1:${config.port}/v1`||config["auth-dir"]!==auth||!Array.isArray(config["api-keys"])||config["api-keys"].length!==1||config["api-keys"][0]!==connection.apiKey||typeof connection.apiKey!=="string"||!/^[A-Za-z0-9._~-]{32,512}$/.test(connection.apiKey)||config.plugins?.enabled!==false||config["quota-exceeded"]?.["antigravity-credits"]!==false||config["remote-management"]?.["allow-remote"]!==false||config["remote-management"]?.["secret-key"]!==""||config["remote-management"]?.["disable-control-panel"]!==true||config.debug!==false||config["logging-to-file"]!==false||config["request-log"]!==false||config["commercial-mode"]!==true)throw new Error();
  if(config["usage-statistics-enabled"]!==false||config["request-retry"]!==0||config["max-retry-credentials"]!==1||config["quota-exceeded"]?.["switch-project"]!==false||config["quota-exceeded"]?.["switch-preview-model"]!==false||config["ws-auth"]!==true)throw new Error();
  const bytes=privateFile(binary,100_000_000);
  if(createHash("sha256").update(bytes).digest("hex")!==(options?.sha256??PINNED_BINARY_SHA256))throw new Error();
  return {binary,directory,auth,configPath:join(directory,"config.json"),baseUrl:connection.baseUrl,apiKey:connection.apiKey};
}
export function proxyEnvironment(){const env={};for(const key of ["HOME","PATH","USER","LOGNAME","TMPDIR","LANG","LC_ALL"])if(process.env[key]!==undefined)env[key]=process.env[key];return env;}
