import { useState } from 'react';
import type { ReactNode } from 'react';
import { faCaretUp, faCaretDown } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './iconButton.tsx';

type SortValue = string | number | boolean | null | undefined;

interface Column<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  sort?: (row: T) => SortValue;
  desc?: boolean;
  num?: boolean;
  className?: string;
}

interface SortState {
  key: string;
  dir: 1 | -1;
}

const blank = (v: SortValue) => v == null || v === '';

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'boolean') a = Number(a);
  if (typeof b === 'boolean') b = Number(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'ko', { numeric: true });
}

function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState | null): T[] {
  const col = sort && columns.find((c) => c.key === sort.key);
  if (!sort || !col?.sort) return rows;
  const by = col.sort;
  return [...rows].sort((x, y) => {
    const a = by(x);
    const b = by(y);
    if (blank(a) || blank(b)) return Number(blank(a)) - Number(blank(b));
    return compare(a, b) * sort.dir;
  });
}

export function SortTable<T>({ rows, columns, rowKey, initial = null, compact = false, limit, rowClass }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, i: number) => string | number;
  initial?: SortState | null;
  compact?: boolean;
  limit?: number;
  rowClass?: (row: T) => string | undefined;
}) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const sorted = sortRows(rows, columns, sort);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const firstDir = (c: Column<T>): 1 | -1 => (c.desc || c.num ? -1 : 1);
  const toggle = (c: Column<T>) => setSort((s) => ({
    key: c.key,
    dir: s?.key === c.key ? (s.dir === 1 ? -1 : 1) : firstDir(c),
  }));

  return (
    <>
      <div className="list-total">전체 <span className="count">{rows.length}</span></div>
      <table className={`table table-cards${compact ? ' table-compact' : ''}`}>
        <thead>
          <tr>
            {columns.map((c) => {
              if (!c.sort) return <th key={c.key} className={c.num ? 'num' : undefined}>{c.label}</th>;
              const active = sort?.key === c.key;
              return (
                <th key={c.key} className={c.num ? 'num' : undefined} aria-sort={active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="th-sort" onClick={() => toggle(c)}>
                    {c.label}{active ? <Icon icon={sort.dir > 0 ? faCaretUp : faCaretDown} className="sort-caret" /> : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={rowKey(r, i)} className={rowClass?.(r)}>
              {columns.map((c) => (
                <td key={c.key} className={[c.num ? 'num' : '', c.className ?? ''].join(' ').trim() || undefined}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
