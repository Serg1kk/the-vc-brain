const NUMBER_WORDS: Record<number, string> = {
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
};

// "One thing your deck didn't cover" / "Three things your deck didn't cover"
export function questionsTitle(count: number): string {
  const word = NUMBER_WORDS[count] ?? String(count);
  const noun = count === 1 ? "thing" : "things";
  return `${word} ${noun} your deck didn't cover`;
}

export function questionsProgress(current: number, total: number): string {
  return `Question ${current} of ${total}`;
}

const REL =
  typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const diff = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diff);
  if (!REL) return abs < 60 ? "just now" : new Date(iso).toLocaleString();
  if (abs < 60) return REL.format(diff, "second");
  if (abs < 3600) return REL.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return REL.format(Math.round(diff / 3600), "hour");
  return REL.format(Math.round(diff / 86400), "day");
}
