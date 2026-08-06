import { toJstDateString } from "@rss-summary/shared";

/** 直近N日分(今日を含む)のJST日付文字列を、新しい順で返す */
export function recentJstDates(days: number, now = new Date()): string[] {
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const target = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(toJstDateString(target));
  }
  return dates;
}
