export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-ink-800 px-5">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold text-ink-100">
          {title}
        </h1>
        {subtitle && (
          <p className="truncate text-xs text-ink-400">{subtitle}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}
