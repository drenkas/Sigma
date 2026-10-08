import { Worker } from "node:worker_threads";
import type { JournalEvent } from "../../packages/contracts/index.js";

export class Storage {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  private failure:Error|undefined;
  constructor(path: string) {
    this.worker = new Worker(new URL("./storage-worker.mjs", import.meta.url), { workerData: { path } });
    this.worker.on("message", ({id,value,error}) => { const p=this.pending.get(id); if (!p) return; this.pending.delete(id); error ? p.reject(new Error(error)) : p.resolve(value); });
    this.worker.on("error", error => { this.failure=error;for (const p of this.pending.values()) p.reject(error); this.pending.clear(); });
    this.worker.on("exit", code => {if(!this.failure)this.failure=new Error(`Storage worker exited (${code})`);for(const p of this.pending.values())p.reject(this.failure);this.pending.clear();});
  }
  call<T=any>(op:string,args:Record<string,unknown>={}):Promise<T> { if(this.failure)return Promise.reject(this.failure);const id=++this.nextId; return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,op,args});}); }
  event(sessionId:string,type:string,payload:unknown):Promise<JournalEvent> { return this.call("event",{sessionId,type,payload}); }
  close():Promise<number>{return this.worker.terminate();}
}
