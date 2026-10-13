import { createMemo, Index, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Lexer, type Tokens } from "marked";

// Renders GitHub-flavored Markdown as Solid elements built from marked's token tree.
// Nothing here touches innerHTML: raw HTML in the source is shown as plain text,
// links are limited to http(s)/mailto, and images are shown as links (CSP blocks remote images).
type T = Tokens.Generic;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", times: "×", divide: "÷", deg: "°", plusmn: "±", laquo: "«", raquo: "»", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", ne: "≠", le: "≤", ge: "≥", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", check: "✓" };
const decode = (s: string) => s.indexOf("&") < 0 ? s : s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,15}));/g, (m, d, h, n) => {
  if (n) return ENTITIES[n] ?? m;
  const c = d ? parseInt(d, 10) : parseInt(h, 16);
  return c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : "�";
});

const safeHref = (raw: unknown, literal = false): string | null => {
  if (typeof raw !== "string") return null;
  const h = (literal ? raw : decode(raw)).trim();
  if (!/^(https?:|mailto:)/i.test(h)) return null;
  try { new URL(h); } catch { return null; }
  return h;
};

const inline = (tokens: T[] | undefined, raw = ""): JSX.Element => tokens?.length ? tokens.map(inl) : raw;

function inl(t: T): JSX.Element {
  switch (t.type) {
    case "text": return t.tokens?.length ? inline(t.tokens) : t.escaped === false ? decode(t.text ?? "") : (t.text ?? t.raw ?? "");
    case "escape": return t.text ?? "";
    case "strong": return <strong>{inline(t.tokens, t.text)}</strong>;
    case "em": return <em>{inline(t.tokens, t.text)}</em>;
    case "del": return <del>{inline(t.tokens, t.text)}</del>;
    case "codespan": return <code class="md-code-inline">{t.text}</code>;
    case "br": return <br />;
    case "checkbox": return <input type="checkbox" class="md-check" checked={!!t.checked} disabled aria-label={t.checked ? "Done" : "Not done"} />;
    case "link": {
      const href = safeHref(t.href, !!t.autolink);
      const body = inline(t.tokens, t.text);
      return href ? <a href={href} target="_blank" rel="noopener noreferrer" title={typeof t.title === "string" ? decode(t.title) : undefined}>{body}</a> : <span>{body}</span>;
    }
    case "image": {
      const href = safeHref(t.href), alt = decode(t.text || "");
      return href ? <a href={href} target="_blank" rel="noopener noreferrer" class="md-image">{alt || href}</a> : <span>{alt}</span>;
    }
    case "html": return <span class="md-raw">{t.raw ?? t.text}</span>;
    default: return t.tokens?.length ? inline(t.tokens) : (t.raw ?? t.text ?? "");
  }
}

const cellClass = (a: string | null) => a ? `md-align-${a}` : undefined;

function listItem(it: T): JSX.Element {
  return <li class={it.task ? "md-task" : undefined}>{(it.tokens as T[] | undefined)?.map(b => b.type === "text" ? <>{inline(b.tokens, b.text)}</> : b.type === "checkbox" ? inl(b) : block(b))}</li>;
}

function block(t: T): JSX.Element {
  switch (t.type) {
    case "space": case "def": return null;
    case "paragraph": return <p>{inline(t.tokens, t.text)}</p>;
    case "text": return <p>{inline(t.tokens, t.text)}</p>;
    case "heading": return <Dynamic component={`h${Math.min(6, Math.max(1, t.depth || 1))}`}>{inline(t.tokens, t.text)}</Dynamic>;
    case "hr": return <hr />;
    case "blockquote": return <blockquote>{(t.tokens as T[] | undefined)?.map(block)}</blockquote>;
    case "code": {
      const lang = typeof t.lang === "string" ? t.lang.trim().split(/\s+/)[0].slice(0, 24) : "";
      return <div class="md-code">{lang ? <span class="md-lang">{lang}</span> : null}<pre><code>{t.text}</code></pre></div>;
    }
    case "list": {
      const items = (t.items as T[]).map(listItem);
      return t.ordered ? <ol start={typeof t.start === "number" && t.start !== 1 ? t.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table": return (
      <div class="md-table"><table>
        <thead><tr>{(t.header as Tokens.TableCell[]).map(c => <th class={cellClass(c.align)}>{inline(c.tokens as T[], c.text)}</th>)}</tr></thead>
        <Show when={t.rows.length}><tbody>{(t.rows as Tokens.TableCell[][]).map(r => <tr>{r.map(c => <td class={cellClass(c.align)}>{inline(c.tokens as T[], c.text)}</td>)}</tr>)}</tbody></Show>
      </table></div>
    );
    case "html": return <p class="md-raw">{(t.text ?? t.raw ?? "").replace(/\s+$/, "")}</p>;
    default: return t.tokens?.length ? <p>{inline(t.tokens)}</p> : <p>{t.raw ?? t.text ?? ""}</p>;
  }
}

export function Markdown(props: { text: string; class?: string }) {
  const tokens = createMemo(() => Lexer.lex(props.text ?? "", { gfm: true }) as T[]);
  return <div class={props.class}><Index each={tokens()}>{t => {
    // Only re-render a block when its source changed (streaming drafts append to the last block).
    const tok = createMemo(() => t(), undefined, { equals: (a, b) => a.type === b.type && a.raw === b.raw });
    return <>{block(tok())}</>;
  }}</Index></div>;
}
