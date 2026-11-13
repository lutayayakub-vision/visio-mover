import Reveal from "../ui/Reveal";
import Button from "../ui/Button";

export default function FinalCTA() {
  return (
    <section className="section">
      <div className="container">
        <Reveal>
          <div className="cta card">
            <h2>Your Content. <span className="gradient-text">Clean. Clear. Yours.</span></h2>
            <p>Create an account to be first in line when the workspace opens.</p>
            <Button to="/register" size="lg">Get Started</Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
