import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Logo from "./Logo";
import Button from "../ui/Button";
import { useAuth } from "../../auth/AuthContext";

const links = [
  { href: "#home", label: "Home" },
  { href: "#features", label: "Features" },
  { href: "#how", label: "How It Works" },
  { href: "#pricing", label: "Pricing" },
];

export default function Navbar() {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className={`nav ${scrolled ? "nav-scrolled" : ""}`}>
      <div className="container nav-inner">
        <Logo />
        <nav className={`nav-links ${open ? "open" : ""}`} aria-label="Primary">
          {links.map((l) => (
            <a key={l.href} href={l.href} onClick={close}>{l.label}</a>
          ))}
          {session ? (
            <div className="nav-cta-mobile"><Button to="/dashboard">Dashboard</Button></div>
          ) : (
            <>
              <Link to="/login" className="nav-login" onClick={close}>Login</Link>
              <div className="nav-cta-mobile"><Button to="/register">Get Started</Button></div>
            </>
          )}
        </nav>
        <div className="nav-actions">
          {session ? (
            <span className="nav-cta-desktop"><Button to="/dashboard">Dashboard</Button></span>
          ) : (
            <>
              <Link to="/login" className="nav-login-desktop">Login</Link>
              <span className="nav-cta-desktop"><Button to="/register">Get Started</Button></span>
            </>
          )}
          <button
            className={`burger ${open ? "open" : ""}`}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <i /><i /><i />
          </button>
        </div>
      </div>
    </header>
  );
}
