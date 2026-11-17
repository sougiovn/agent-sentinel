/** A key and what it does, shown in the footer and the `?` dialog. */
export interface Hint {
  key: string;
  label: string;
}

export const HELP_HINT: Hint = { key: "?", label: "help" };

const SEP = " · ";

export function hintText(h: Hint): string {
  return `${h.key} ${h.label}`;
}

/**
 * As many whole hints as fit in `width` columns, in order, joined by " · ".
 * A trailing "…" marks hints that were left out; it is counted in the width.
 */
export function fitHints(hints: Hint[], width: number): string {
  const parts = hints.map(hintText);
  const full = parts.join(SEP);
  if (full.length <= width) return full;
  let out = "";
  for (const p of parts) {
    const next = out ? `${out}${SEP}${p}` : p;
    if (`${next}${SEP}…`.length > width) break;
    out = next;
  }
  return out ? `${out}${SEP}…` : width >= 1 ? "…" : "";
}

/** Hints whose key or label contains every whitespace-separated word of the query (case-insensitive). */
export function filterHints<T extends Hint>(hints: T[], query: string): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return hints;
  return hints.filter((h) => {
    const text = `${h.key} ${h.label}`.toLowerCase();
    return tokens.every((t) => text.includes(t));
  });
}
