export type Attachment = { id:string; name:string; mimeType:string; data:string };
export const MAX_IMAGES=4,IMAGE_TYPES=["image/png","image/jpeg","image/gif","image/webp"],MAX_SIDE=2000,MAX_BYTES=3.5*1024*1024;
const base64=(blob:Blob)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
const encode=(canvas:HTMLCanvasElement,quality:number)=>new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/jpeg",quality));
// Oversized images are re-encoded as JPEG (flattened on white); small PNG/WebP/GIF keep their bytes. Returns null when no encoding fits the byte budget.
async function shrink(bitmap:ImageBitmap):Promise<Blob|null>{
  let scale=Math.min(1,MAX_SIDE/Math.max(bitmap.width,bitmap.height));
  for(let attempt=0;attempt<4;attempt++,scale*=0.75){
    const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext("2d");if(!context)return null;context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await encode(canvas,0.85);if(blob&&blob.size<=MAX_BYTES)return blob;
  }
  return null;
}
export async function readImages(files:File[],room:number):Promise<{added:Attachment[];errors:string[]}>{
  const added:Attachment[]=[],errors:string[]=[];
  for(const file of files){
    const name=file.name||"pasted image";
    if(!IMAGE_TYPES.includes(file.type)){errors.push(`${name} is not a PNG, JPEG, GIF or WebP image.`);continue;}
    if(added.length>=room){errors.push(`${name} was not attached: at most ${MAX_IMAGES} images per message.`);continue;}
    try{
      const bitmap=await createImageBitmap(file);
      try{
        if(Math.max(bitmap.width,bitmap.height)<=MAX_SIDE&&file.size<=MAX_BYTES){added.push({id:crypto.randomUUID(),name,mimeType:file.type,data:await base64(file)});continue;}
        const blob=await shrink(bitmap);
        if(!blob){errors.push(`${name} could not be reduced below ${(MAX_BYTES/1024/1024).toFixed(1)} MB.`);continue;}
        added.push({id:crypto.randomUUID(),name,mimeType:"image/jpeg",data:await base64(blob)});
      }finally{bitmap.close();}
    }catch{errors.push(`${name} could not be read as an image.`);}
  }
  return {added,errors};
}
// Identifies the attached set for prompt idempotency without keeping the bytes: count, then per image length and FNV-1a of the base64 text.
export function fingerprint(images:Attachment[]){
  return images.length?`${images.length}|${images.map(image=>{let hash=0x811c9dc5;for(let i=0;i<image.data.length;i++){hash^=image.data.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}return `${image.mimeType}:${image.data.length}:${hash.toString(16)}`;}).join("|")}`:"";
}
