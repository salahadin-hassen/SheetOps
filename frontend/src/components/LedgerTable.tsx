import { Fragment, useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** The column that names the row; rendered as a row header. */
  rowHeader?: boolean;
  align?: 'right';
}

interface Props<T> {
  caption: string;
  /** Show the caption visually (it is always available to screen readers). */
  showCaption?: boolean;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowClass?: (row: T) => string | undefined;
  /** A full-width line under every row that returns content (always shown). */
  detail?: (row: T) => ReactNode;
  /** Collapsible details: a "Details" toggle in the last column. */
  expand?: (row: T) => ReactNode;
  expandLabel?: (row: T) => string;
  empty?: ReactNode;
  /**
   * On narrow screens, show each row as a stacked block of "label: value"
   * lines instead of a sideways-scrolling table. Explicit ARIA roles keep the
   * table semantics when CSS changes the display of its parts.
   */
  stack?: boolean;
}

/**
 * A data table inside a keyboard-focusable scroll region, so a wide table
 * scrolls in its own box and never widens the page.
 */
export function LedgerTable<T>({ caption, showCaption = false, columns, rows, rowKey, rowClass, detail, expand, expandLabel, empty, stack = false }: Props<T>) {
  const base = useId();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (rows.length === 0 && empty) return <>{empty}</>;
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const span = columns.length + (expand ? 1 : 0);
  return (
    <div className={`table-scroll${stack ? ' stackable' : ''}`} tabIndex={0} role="region" aria-label={`${caption} (table, scrolls sideways)`}>
      <table className={`ledger${stack ? ' stack' : ''}`} role={stack ? 'table' : undefined}>
        <caption className={showCaption ? undefined : 'visually-hidden'}>{caption}</caption>
        <thead role={stack ? 'rowgroup' : undefined}>
          <tr role={stack ? 'row' : undefined}>
            {columns.map((c) => <th key={c.header} scope="col" className={c.align} role={stack ? 'columnheader' : undefined}>{c.header}</th>)}
            {expand ? <th scope="col" className="right" role={stack ? 'columnheader' : undefined}><span className="visually-hidden">Details</span></th> : null}
          </tr>
        </thead>
        <tbody role={stack ? 'rowgroup' : undefined}>
          {rows.map((row, index) => {
            const key = rowKey(row);
            const always = detail?.(row);
            const isOpen = expand ? open.has(key) : false;
            const panelId = `${base}-d${index}`;
            const extra = always ?? (isOpen ? expand!(row) : null);
            return (
              <Fragment key={key}>
                <tr className={['data-row', rowClass?.(row), extra ? 'has-detail' : ''].filter(Boolean).join(' ')} role={stack ? 'row' : undefined}>
                  {columns.map((c) => c.rowHeader
                    ? <th key={c.header} scope="row" className={c.align} role={stack ? 'rowheader' : undefined}>{c.cell(row)}</th>
                    : <td key={c.header} className={c.align} data-label={c.header} role={stack ? 'cell' : undefined}>
                      {/* One wrapper, so a multi-part cell stays in the value column of the stacked layout. */}
                      {stack ? <div className="cell-content">{c.cell(row)}</div> : c.cell(row)}
                    </td>)}
                  {expand ? (
                    <td className="right toggle-cell" role={stack ? 'cell' : undefined}>
                      {/* The visible word stays "Details" so it is always part of the
                          accessible name (WCAG 2.5.3); aria-expanded carries the state. */}
                      <button type="button" className="toggle" aria-expanded={isOpen} aria-controls={panelId}
                        aria-label={`Details for ${expandLabel ? expandLabel(row) : key}`} onClick={() => toggle(key)}>
                        Details
                        <Icon name="chevronRight" size={12} />
                      </button>
                    </td>
                  ) : null}
                </tr>
                {extra ? <tr className="detail-row" id={panelId} role={stack ? 'row' : undefined}><td colSpan={span} role={stack ? 'cell' : undefined}>{extra}</td></tr> : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
