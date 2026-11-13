import Reveal from "../ui/Reveal";

const items = [
  { title: "Your content, your permission", text: "VISIOMOVER is for content you own or are authorized to edit. It must not be used to strip third-party copyright, licensing or attribution marks.", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
  { title: "Private by design", text: "The plan is private accounts with each user's files and projects separated from everyone else's.", icon: "M4 11h16v10H4zM8 11V8a4 4 0 0 1 8 0v3" },
  { title: "Checked uploads", text: "Planned: file types verified from actual content, size limits and malware scanning where feasible.", icon: "M5 12l4 4 10-10" },
  { title: "Temporary by default", text: "Planned: expired temporary files are cleaned up automatically, and downloads use short-lived links.", icon: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
];

export default function Trust() {
  return (
    <section id="trust" className="section">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <span className="eyebrow">Privacy and security</span>
            <h2>Built around responsible handling of your files</h2>
            <p>We follow established security practices and test our access controls. No online service can promise perfect security, so we state what we are building rather than overpromise.</p>
          </div>
        </Reveal>
        <div className="trust-grid">
          {items.map((t, i) => (
            <Reveal key={t.title} delay={i * 80}>
              <article className="card trust">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
                <h3>{t.title}</h3>
                <p>{t.text}</p>
              </article>
            </Reveal>
          ))}
        </div>
        <p className="trust-note">Items marked "planned" are not live yet. This stage is a frontend only.</p>
      </div>
    </section>
  );
}
