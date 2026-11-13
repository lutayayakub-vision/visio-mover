import Button from "../ui/Button";
import CompareSlider from "../compare/CompareSlider";
import DemoScene from "../compare/DemoScene";

export default function Hero() {
  return (
    <section id="home" className="hero">
      <div className="container hero-grid">
        <div className="hero-copy">
          <span className="pill"><i /> Private by design · Your files stay yours</span>
          <h1>
            Remove the Unwanted. <span className="gradient-text">Reveal the Original.</span>
          </h1>
          <p className="hero-sub">
            Transform your images, videos and documents with an intelligent editing workspace designed for simplicity, precision and control.
          </p>
          <div className="hero-actions">
            <Button to="/register" size="lg">Get Started</Button>
            <Button href="#features" variant="ghost" size="lg">Explore Features</Button>
          </div>
          <ul className="hero-trust">
            <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg> Private by design</li>
            <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg> Verified uploads (planned)</li>
            <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg> Your permission, your content</li>
          </ul>
        </div>

        <div className="hero-visual">
          <div className="float-card float-img" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 8" /></svg>
            <span>Images</span>
          </div>
          <div className="float-card float-vid" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="14" height="14" rx="3" /><path d="M17 10l4-2v8l-4-2" /></svg>
            <span>Video</span>
          </div>
          <div className="float-card float-doc" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></svg>
            <span>Docs</span>
          </div>

          <div className="demo-frame">
            <div className="demo-bar">
              <span /><span /><span />
              <em>demo-preview.png</em>
            </div>
            <CompareSlider
              autoDemo
              beforeLabel="Before"
              afterLabel="After"
              before={<DemoScene marked />}
              after={<DemoScene marked={false} />}
            />
          </div>
          <p className="demo-caption">Interactive preview using an illustration. Drag the line to compare.</p>
        </div>
      </div>
    </section>
  );
}
