import { Link } from "react-router-dom";
import Button from "../components/ui/Button";

/** Honest stand-in for pages that arrive in later stages. */
export default function Placeholder({ title, stage }: { title: string; stage: string }) {
  return (
    <section className="placeholder">
      <div className="container">
        <div className="card placeholder-card">
          <span className="badge soon">{stage}</span>
          <h1>{title}</h1>
          <p>This page is planned for a later stage and is not built yet.</p>
          <div className="placeholder-actions">
            <Button to="/">Back to home</Button>
            <Link to="/#features" className="placeholder-link">See what's coming</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
