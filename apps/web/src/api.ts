export async function api<T>(path:string,method="GET",body?:unknown,commandId?:string,signal?:AbortSignal):Promise<T>{
  const res=await fetch(`/api${path}`,{method,credentials:"same-origin",signal,headers:{...(body===undefined?{}:{"Content-Type":"application/json"}),...(commandId?{"X-Command-Id":commandId}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();if(!res.ok)throw Object.assign(new Error(data.error||`HTTP ${res.status}`),{status:res.status});return data;
}
