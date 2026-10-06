import type { ReactNode } from "react";

export function PageTitle({
  eyebrow,
  title,
  sub,
  action,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 tabIndex={-1}>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </header>
  );
}
