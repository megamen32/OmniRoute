/** Native ZCode sometimes returns reasoning wrappers inside its final text. */
export function normalizeZcodeResponseText(text: string, reasoning = "") {
  const thoughts = reasoning ? [reasoning] : [];
  let content = text;
  // Only protocol prefixes, not quoted examples or tool arguments, are consumed.
  while (true) {
    const marker = content.match(
      /^\s*\[COMPRESSED:(?:summary|aging:(?:fullSummary|moderate|light|verbatim))\]\s*/
    );
    if (marker) {
      content = content.slice(marker[0].length);
      continue;
    }
    const open = content.match(/^\s*<think>\s*/);
    if (!open) break;
    const close = content.indexOf("</think>", open[0].length);
    const end = close < 0 ? content.length : close;
    // Repeated opens occur in native output; they are delimiters, not prose.
    const thought = content.slice(open[0].length, end).replaceAll("<think>", "").trim();
    if (thought) thoughts.push(thought);
    content = close < 0 ? "" : content.slice(close + "</think>".length).trimStart();
  }
  return { content, reasoning: thoughts.join("\n\n") };
}
