import Reveal from "../ui/Reveal";
import Button from "../ui/Button";

const plans = [
  {
    name: "Starter",
    price: "Free",
    note: "To try the workspace",
    items: ["Image editing", "Small storage allowance", "Standard queue"],
    featured: false,
  },
  {
    name: "Pro",
    price: "TBA",
    note: "For regular creators",
    items: ["Images, video and documents", "Larger storage", "Priority queue", "Longer file retention"],
    featured: true,
  },
  {
    name: "Team",
    price: "TBA",
    note: "For studios and businesses",
    items: ["Shared workspaces", "Highest limits", "Priority support"],
    featured: false,
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="section">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <span className="eyebrow">Pricing</span>
            <h2>Simple plans, honest limits</h2>
            <p>Pricing preview. Final plans and amounts will be confirmed before launch.</p>
          </div>
        </Reveal>
        <div className="pricing-grid">
          {plans.map((p, i) => (
            <Reveal key={p.name} delay={i * 90}>
              <article className={`card plan ${p.featured ? "plan-featured" : ""}`}>
                {p.featured && <span className="plan-flag">Most popular</span>}
                <h3>{p.name}</h3>
                <div className="plan-price">{p.price}</div>
                <p className="plan-note">{p.note}</p>
                <ul>
                  {p.items.map((it) => (
                    <li key={it}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
                      {it}
                    </li>
                  ))}
                </ul>
                <Button to="/register" variant={p.featured ? "primary" : "ghost"}>Get Started</Button>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
