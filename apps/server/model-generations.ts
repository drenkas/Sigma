/** Returns `provider/id` keys of models outside their family's newest generation (family = provider + id prefix before the first numeric version token). */
export function previousGeneration(models:{provider:string;id:string}[]):Set<string>{
  const parsed=models.flatMap(m=>{const tokens=m.id.split("-"),at=tokens.findIndex(t=>/^\d+(\.\d+)*$/.test(t));return at>0?[{key:`${m.provider}/${m.id}`,family:`${m.provider}\0${tokens.slice(0,at).join("-")}`,major:parseInt(tokens[at],10)}]:[];});
  const newest=new Map<string,number>();for(const p of parsed)newest.set(p.family,Math.max(newest.get(p.family)??-Infinity,p.major));
  return new Set(parsed.filter(p=>p.major<newest.get(p.family)!).map(p=>p.key));
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
