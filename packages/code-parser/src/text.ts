/** Remove one pair of matching surrounding quotes or backticks. */
export function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'" || first === "`") && first === last) return text.slice(1, -1);
  }
  return text;
}

export function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // Avoid splitting a surrogate pair at the cut.
  let cut = max - 1;
  const code = flat.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${flat.slice(0, cut)}…`;
}
