import Reveal from "../ui/Reveal";

const features = [
  { title: "Image Editing", text: "Brush over an area you're authorized to edit and reconstruct it from the surrounding pixels, with zoom, pan and adjustable brush size.", icon: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M9 9a1 1 0 1 0 0 .01", anim: "a-pan" },
  { title: "Video Editing", text: "Select a region, follow it across frames and rebuild it. Long jobs are designed to run in the background.", icon: "M3 6h12v12H3zM15 10l6-3v10l-6-3", anim: "a-play" },
  { title: "Document Editing", text: "Work with PDF, DOCX and PPTX while aiming to keep text, tables, images and page structure intact.", icon: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6", anim: "a-lift" },
  { title: "Smart Area Selection", text: "Precise brush and selection tools so only the area you choose is touched.", icon: "M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6M12 9v6M9 12h6", anim: "a-spin" },
  { title: "Before-and-After Comparison", text: "Drag a line to compare original and result on desktop or touch screens, and restore the original any time.", icon: "M12 3v18M8 8l-4 4 4 4M16 8l4 4-4 4", anim: "a-sway" },
  { title: "Secure File Handling", text: "Planned: private per-user accounts, access-controlled storage and short-lived download links.", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4", anim: "a-lift" },
];

export default function Features() {
  return (
    <section id="features" className="section">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <span className="eyebrow">Features</span>
            <h2>One workspace for every kind of clean-up</h2>
            <p>Designed for content you own or are authorized to edit. These capabilities are the product roadmap; the editing engines arrive in later stages.</p>
          </div>
        </Reveal>
        <div className="feature-grid">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={i * 70}>
              <article className="card feature">
                <div className={`feature-icon ${f.anim}`}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={f.icon} /></svg>
                </div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
