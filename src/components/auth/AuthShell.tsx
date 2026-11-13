import type { ReactNode } from "react";
import Logo from "../layout/Logo";

export default function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="auth">
      <div className="auth-card card">
        <div className="auth-logo"><Logo /></div>
        <h1>{title}</h1>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </div>
    </section>
  );
}
