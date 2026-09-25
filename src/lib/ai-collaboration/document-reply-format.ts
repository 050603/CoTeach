const CHINESE_NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

type ListMarker = { index: number; length: number; number: number; style: "arabic" | "chinese" };

function markerNumber(value: string): Pick<ListMarker, "number" | "style"> {
  const digit = value.match(/\d{1,2}/u)?.[0];
  if (digit) return { number: Number(digit), style: "arabic" };
  const chinese = value.match(/[一二三四五六七八九十]/u)?.[0] ?? "";
  return { number: CHINESE_NUMBERS[chinese] ?? 0, style: "chinese" };
}

function formatLine(line: string): string {
  // Leave code and links untouched; their numbers can be part of syntax or a value.
  if (line.includes("`") || line.includes("](")) return line;
  const markerPattern = /[1-9]\d?[.、．](?!\d)|[一二三四五六七八九十]、|[（(][1-9]\d?[）)]|[（(][一二三四五六七八九十][）)]/gu;
  const markers: ListMarker[] = [...line.matchAll(markerPattern)].map((match) => ({
    index: match.index,
    length: match[0].length,
    ...markerNumber(match[0]),
  }));
  const runStart = markers.findIndex((marker, index) => {
    const next = markers[index + 1];
    return next && next.style === marker.style && next.number === marker.number + 1;
  });
  if (runStart < 0) return line;

  let runEnd = runStart + 1;
  while (
    runEnd + 1 < markers.length
    && markers[runEnd + 1].style === markers[runEnd].style
    && markers[runEnd + 1].number === markers[runEnd].number + 1
  ) runEnd += 1;

  const first = markers[runStart];
  const prefix = line.slice(0, first.index).trimEnd();
  const items = markers.slice(runStart, runEnd + 1).map((marker, index, run) => {
    const next = run[index + 1];
    const text = line.slice(marker.index + marker.length, next?.index ?? line.length).trim();
    return `${marker.number}. ${text}`;
  });
  return `${prefix}${prefix ? "\n\n" : ""}${items.join("\n")}`;
}

/** Repair inline numbered lists in old document AI replies without changing their wording. */
export function formatDocumentReplyForDisplay(content: string): string {
  let fence: "```" | "~~~" | null = null;
  return content.split("\n").map((line) => {
    const delimiter = line.trimStart().match(/^(```|~~~)/u)?.[1] as typeof fence;
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (fence === delimiter) fence = null;
      return line;
    }
    if (fence || line.startsWith("    ") || line.includes("|")) return line;
    return formatLine(line);
  }).join("\n");
}
