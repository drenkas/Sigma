/** Returns older generations per provider/family. Claude compares full versions; other families compare major generations. */
export function previousGeneration(models:{provider:string;id:string}[]):Set<string>{
  const parsed=models.flatMap(m=>{
    const tokens=m.id.split("-"),at=tokens.findIndex(t=>/^\d+(\.\d+)*$/.test(t));
    if(at<=0)return [];
    const version=[parseInt(tokens[at],10)];
    if(m.id.startsWith("claude-")){
      version.splice(0,1,...versionParts(tokens[at]));
      for(const token of tokens.slice(at+1)){
        if(!/^\d+(\.\d+)*$/.test(token)||/^\d{8}$/.test(token))break;
        version.push(...versionParts(token));
      }
    }
    return [{key:`${m.provider}/${m.id}`,family:`${m.provider}\0${tokens.slice(0,at).join("-")}`,version}];
  });
  const newest=new Map<string,number[]>();for(const p of parsed)if(!newest.has(p.family)||cmpVersion(p.version,newest.get(p.family)!)>0)newest.set(p.family,p.version);
  return new Set(parsed.filter(p=>cmpVersion(p.version,newest.get(p.family)!)<0).map(p=>p.key));
}

const versionParts=(v:string)=>v.split(".").map(Number);
const cmpVersion=(a:number[],b:number[])=>{for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]??0)-(b[i]??0);if(d)return d;}return 0;};
/** Returns `provider/id` keys of `gemini-*` models other than the newest-version plain Flash (numeric version then `flash`, no `lite`/`image` token). Empty when no plain Flash exists. */
export function geminiNonFlash(models:{provider:string;id:string}[]):Set<string>{
  const gem=models.filter(m=>m.id.startsWith("gemini-"));
  const plain=gem.flatMap(m=>{const t=m.id.split("-"),at=t.findIndex(x=>/^\d+(\.\d+)*$/.test(x));return at>0&&t[at+1]==="flash"&&!t.includes("lite")&&!t.includes("image")?[{m,v:versionParts(t[at])}]:[];});
  if(!plain.length)return new Set();
  const best=plain.reduce((a,b)=>cmpVersion(b.v,a.v)>0?b:a).m;
  return new Set(gem.filter(m=>m!==best).map(m=>`${m.provider}/${m.id}`));
}
