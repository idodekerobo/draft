/** "Dev is watching", "Dev and Priya are watching", "Dev, Priya and 2 others are watching". Empty when nobody is. */
export function presenceLine(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is watching`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are watching`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are watching`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are watching`;
}
