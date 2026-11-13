import { Link } from "react-router-dom";
import Logo from "./Logo";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <Logo />
          <p>Your Content. Clean. Clear. Yours.</p>
          <p className="footer-note">
            Use VISIOMOVER only on content you own or are authorized to edit. Removing third-party
            copyright, licensing or attribution marks without permission is not allowed.
          </p>
        </div>
        <div>
          <h4>Product</h4>
          <Link to="/#features">Features</Link>
          <Link to="/#how">How It Works</Link>
          <Link to="/#pricing">Pricing</Link>
        </div>
        <div>
          <h4>Company</h4>
          <Link to="/about">About</Link>
          <Link to="/contact">Contact</Link>
          <Link to="/support">Support</Link>
        </div>
        <div>
          <h4>Legal</h4>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} VISIOMOVER. All rights reserved.</span>
        <span>Stage 1 preview · frontend only</span>
      </div>
    </footer>
  );
}
