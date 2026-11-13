import { Link } from "react-router-dom";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  to?: string;
  href?: string;
  variant?: "primary" | "ghost";
  size?: "md" | "lg";
  onClick?: () => void;
};

export default function Button({ children, to, href, variant = "primary", size = "md", onClick }: Props) {
  const cls = `btn btn-${variant} btn-${size}`;
  if (to) return <Link className={cls} to={to}><span>{children}</span></Link>;
  if (href) return <a className={cls} href={href}><span>{children}</span></a>;
  return <button className={cls} onClick={onClick}><span>{children}</span></button>;
}
