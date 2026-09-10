/**
 * Paged layouts (Plan A2/A5). The roster, part list and settings pages all size themselves from
 * the height actually available rather than from a fixed minimum, and re-pagination keeps the
 * selected row on screen. Nothing here reads the DOM: callers pass measured heights in, which
 * makes the arithmetic testable and keeps layout decisions out of the render loop.
 */

/** Touch targets never shrink below this, whatever the viewport claims (Plan A2/A5). */
export const MIN_ROW_PX = 44;
export const PREFERRED_ROW_PX = 48;

export interface PageMetrics {
  /** Measured height of the scrolling region, in CSS pixels. */
  readonly availableHeight: number;
  /** Preferred row size; clamped up to MIN_ROW_PX and down to what fits. */
  readonly rowPx?: number;
  /** Header, tabs, footer and pager that are always visible. */
  readonly fixedPx?: number;
  /** Fewest rows a page may show before the list scrolls within the page. */
  readonly minRows?: number;
  /** Hard ceiling for the layout (three part cards on desktop, one or two on a phone). */
  readonly maxRows?: number;
}

export interface PageState {
  readonly page: number;
  readonly pages: number;
  readonly perPage: number;
  readonly firstRow: number;
  readonly lastRow: number;
  readonly rowPx: number;
}

export function rowsPerPage(metrics: PageMetrics): number {
  const available = Math.max(0, metrics.availableHeight - (metrics.fixedPx ?? 0));
  const rowPx = Math.max(MIN_ROW_PX, metrics.rowPx ?? PREFERRED_ROW_PX);
  const minRows = Math.max(1, metrics.minRows ?? 1);
  const fitted = Math.max(minRows, Math.floor(available / rowPx));
  return metrics.maxRows === undefined ? fitted : Math.min(fitted, Math.max(minRows, metrics.maxRows));
}

export function pageCount(total: number, perPage: number): number {
  const rows = Math.max(0, Math.floor(total));
  return Math.max(1, Math.ceil(rows / Math.max(1, perPage)));
}

export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(0, Math.floor(page)), Math.max(0, pages - 1));
}

/**
 * Re-pagination rule: a row the pilot had selected must stay visible. The current page is kept
 * when it still contains the selection, so shrinking the window does not also move the list.
 */
export function pagePreservingSelection(selected: number, page: number, pages: number, perPage: number): number {
  const clamped = clampPage(page, pages);
  if (selected < 0) return clamped;
  const first = clamped * perPage;
  if (selected >= first && selected < first + perPage) return clamped;
  return clampPage(Math.floor(selected / perPage), pages);
}

/** The single entry point every paged screen calls. */
export function paginate(metrics: PageMetrics, total: number, selected: number, page: number): PageState {
  const perPage = rowsPerPage(metrics);
  const pages = pageCount(total, perPage);
  const current = pagePreservingSelection(selected, page, pages, perPage);
  const firstRow = Math.min(current * perPage, Math.max(0, total - 1));
  return {
    page: current,
    pages,
    perPage,
    firstRow,
    lastRow: Math.min(firstRow + perPage, total),
    rowPx: Math.max(MIN_ROW_PX, metrics.rowPx ?? PREFERRED_ROW_PX),
  };
}

/** Rows on the numbered page, for rendering one page of a roster or a part list. */
export function pageSlice<T>(items: readonly T[], state: PageState): readonly T[] {
  return items.slice(state.firstRow, state.lastRow);
}

/** Phone layouts page four seats at a time; a page count of one disables the pager. */
export function pagerLabel(state: PageState): string {
  return `Page ${state.page + 1} of ${state.pages}`;
}

export function canPage(state: PageState, direction: -1 | 1): boolean {
  return state.page + direction >= 0 && state.page + direction < state.pages;
}
