import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

/** Synthetic canonical provider shared by SDK regressions and isolated browser QA. */
export function registerAuthFixture(runtime:ModelRuntime,id="sigma-auth-fixture"){
  let callback:()=>void=()=>{},release:()=>void=()=>{};
  const controls={logins:0,finalized:0,syncFailure:false,callback:()=>callback(),release:()=>release()};
  const credential=():OAuthCredential=>({type:"oauth",access:"synthetic-access-only",refresh:"synthetic-refresh-only",expires:Date.now()+3600000});
  runtime.registerNativeProvider({
    id,name:"Synthetic SDK account",getModels:()=>[],
    auth:{oauth:{name:"Sign in to synthetic SDK account",login:async(interaction:ProviderAuthInteraction)=>{
      controls.logins++;
      const mode=await interaction.prompt({type:"select",message:"Synthetic sign-in scenario",options:[{id:"manual",label:"Manual code"},{id:"callback",label:"Callback wins"},{id:"device",label:"Device code"},{id:"hold",label:"Held cancellation finalizer"},{id:"error",label:"Provider failure"},{id:"unsafe",label:"Invalid sign-in URL"}]});
      if(mode==="error")throw new Error("synthetic-access-only error / synthetic-refresh-only cause");
      if(mode==="unsafe"){interaction.notify({type:"auth_url",url:"javascript:invalid"});interaction.signal.throwIfAborted();return credential();}
      interaction.notify({type:"auth_url",url:"https://example.invalid/synthetic-sign-in"});
      try{
        if(mode==="callback"){
          const promptAbort=new AbortController();
          const manual=interaction.prompt({type:"manual_code",message:"Synthetic callback or manual code",signal:promptAbort.signal}).then(()=>"manual",()=>"aborted");
          const winner=await Promise.race([manual,new Promise<string>(resolve=>{callback=()=>resolve("callback");interaction.signal.addEventListener("abort",()=>resolve("abort"),{once:true});})]);
          promptAbort.abort();await manual;interaction.signal.throwIfAborted();if(winner==="aborted")throw new Error("Synthetic prompt aborted");
        }else if(mode==="device"){
          interaction.notify({type:"device_code",verificationUri:"https://example.invalid/device",userCode:"SYNTHETIC",expiresInSeconds:900});
          await interaction.prompt({type:"text",message:"Synthetic device confirmation"});
        }else{
          if(mode==="hold")await interaction.prompt({type:"secret",message:"Synthetic secret"});
          else await interaction.prompt({type:"manual_code",message:"Synthetic manual authorization code"});
        }
        return credential();
      }finally{
        if(mode==="hold")await new Promise<void>(resolve=>{release=resolve;});
        controls.finalized++;
      }
    },refresh:async value=>value,toAuth:async()=>({apiKey:"synthetic-access-only"})}},
    refreshModels:async()=>{if(controls.syncFailure)throw new Error("synthetic-refresh-only catalog failure");},
    stream:()=>{throw new Error("Synthetic auth fixture never makes model calls");},streamSimple:()=>{throw new Error("Synthetic auth fixture never makes model calls");},
  });
  return controls;
}
