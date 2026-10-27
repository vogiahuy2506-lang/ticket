import type { ReactNode } from 'react';

/**
 * A small set of shared presentational components so every page of the
 * storefront looks like it was designed by one person.
 */

type Tone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`badge ring-1 ring-inset ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">
          {title}
        </h2>
        {hint ? (
          <p className="mt-0.5 text-xs text-ink-500">{hint}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">
          {title}
        </h1>
        {subtitle ? (
          <div className="mt-1 text-sm text-ink-500">{subtitle}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A labelled money row. `tone` colours the value so the important number
 * stands out from the supporting ones.
 */
export function MoneyRow({
  label,
  value,
  tone = 'default',
  strong,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'default' | 'success' | 'danger' | 'muted' | 'brand';
  strong?: boolean;
}) {
  const toneClass = {
    default: 'text-ink-900',
    success: 'text-emerald-700',
    danger: 'text-red-700',
    muted: 'text-ink-500',
    brand: 'text-brand-700',
  }[tone];

  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm text-ink-500">{label}</span>
      <span
        className={`table-num whitespace-nowrap ${
          strong ? 'text-base font-bold' : 'text-sm font-semibold'
        } ${toneClass}`}
      >
        {value}
      </span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-ink-300 bg-white/60 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-ink-700">{title}</p>
      {hint ? <p className="max-w-xs text-xs text-ink-500">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'brand' | 'muted';
}) {
  const valueClass = {
    default: 'text-ink-900',
    success: 'text-emerald-700',
    warning: 'text-amber-700',
    brand: 'text-brand-700',
    muted: 'text-ink-500',
  }[tone];

  return (
    <div className="card">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
        {label}
      </p>
      <p className={`mt-1.5 text-lg font-bold table-num ${valueClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-ink-400">{hint}</p> : null}
    </div>
  );
}
