import { useId } from 'react';

export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type PageSize = typeof PAGE_SIZE_OPTIONS[number];

interface PageSizeSelectProps {
  value: PageSize;
  onChange: (value: PageSize) => void;
  className?: string;
}

function PageSizeSelect({ value, onChange, className = '' }: PageSizeSelectProps) {
  const selectId = useId();

  return (
    <div className={`flex shrink-0 items-center gap-2 ${className}`.trim()}>
      <label htmlFor={selectId} className="text-sm text-slate-500 font-medium">
        Show:
      </label>
      <select
        id={selectId}
        value={value}
        onChange={event => onChange(Number(event.target.value) as PageSize)}
        className="w-auto pl-3 pr-8 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
      >
        {PAGE_SIZE_OPTIONS.map(size => (
          <option key={size} value={size}>{size} rows</option>
        ))}
      </select>
    </div>
  );
}

export default PageSizeSelect;
