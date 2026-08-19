export function PlaceholderPage({
  title,
  description,
  legacyHref,
}: {
  title: string;
  description: string;
  legacyHref: string;
}) {
  return (
    <section className="sg25-card p-6 md:p-8">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="mt-3 text-base leading-7 text-sg-muted">{description}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <span className="inline-flex rounded-full bg-sg-primary-soft px-3 py-1 text-sm font-semibold text-sg-primary-soft-fg">
            React/Tailwind migration scaffolded
          </span>
          <a href={legacyHref} className="sg25-btn sg25-btn-primary">
            Open current page
          </a>
        </div>
      </div>
    </section>
  );
}
