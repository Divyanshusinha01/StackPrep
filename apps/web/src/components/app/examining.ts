/**
 * The "Examining src/…" indicator: which files or modules the interviewer just looked at. Holds
 * paths and areas only, never file content or the interviewer's reasoning.
 */

export interface ExaminedItem {
  path: string;
  area?: string;
}

export type ExaminingState = { items: ExaminedItem[]; until: number } | null;

export type ExaminingAction =
  | { type: "examined"; items: ExaminedItem[]; at: number }
  | { type: "expire"; at: number }
  | { type: "reset" };

export const EXAMINING_VISIBLE_MS = 6000;
const MAX_ITEMS = 3;
const MAX_PATH_CHARS = 48;

export function examiningReducer(state: ExaminingState, action: ExaminingAction): ExaminingState {
  switch (action.type) {
    case "examined": {
      const items = action.items.filter((item, i) => action.items.findIndex((other) => other.path === item.path) === i);
      return items.length ? { items: items.slice(0, MAX_ITEMS), until: action.at + EXAMINING_VISIBLE_MS } : state;
    }
    case "expire":
      return state && action.at >= state.until ? null : state;
    case "reset":
      return null;
  }
}

/** Keeps the start and the file name of long paths: `src/features/bil…/invoice.ts`. */
export function shortenPath(path: string, max = MAX_PATH_CHARS): string {
  if (path.length <= max) {
    return path;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  const head = path.slice(0, Math.max(0, max - name.length - 2));
  return name.length + 2 >= max ? `…${path.slice(-(max - 1))}` : `${head}…/${name}`;
}

export function examiningLabel(items: ExaminedItem[]): string {
  if (items.length === 0) {
    return "";
  }
  const first = shortenPath(items[0].path);
  return items.length === 1 ? `Examining ${first}` : `Examining ${first} and ${items.length - 1} more`;
}
