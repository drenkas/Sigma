// Sigma mark: a geometric Σ inside a rounded tile. Colours come from CSS (--logo-bg, --logo-ink).
export function Logo(p:{class?:string;title?:string}){
  return <svg class={`logo ${p.class??""}`} viewBox="0 0 32 32" role={p.title?"img":undefined} aria-label={p.title} aria-hidden={p.title?undefined:"true"}>
    <rect class="logo-tile" width="32" height="32" rx="8"/>
    <path class="logo-glyph" d="M22 9.5H10.5l6.25 6.5-6.25 6.5H22"/>
  </svg>;
}
