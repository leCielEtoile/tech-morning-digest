/** "2026-08-02" -> "2026年8月2日" */
export function formatJstDateLabel(dateLabel: string): string {
  const [year, month, day] = dateLabel.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}
