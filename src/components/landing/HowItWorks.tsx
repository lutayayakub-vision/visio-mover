import { useEffect, useRef, useState } from "react";
import Reveal from "../ui/Reveal";

const steps = [
  { n: "01", title: "Upload your file", text: "Add an image, video or document you own or are authorized to edit.", icon: "M12 16V4M7 9l5-5 5 5M4 20h16" },
  { n: "02", title: "Select the area you are authorized to edit", text: "Mark only the part you have the right to change. Zoom and pan for precision.", icon: "M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6" },
  { n: "03", title: "Preview and download your result", text: "Compare before and after, then download once processing has genuinely completed.", icon: "M12 4v12M7 11l5 5 5-5M4 20h16" },
];

export default function HowItWorks() {
  const ref = useRef<HTMLOListElement>(null);
  const [active, setActive] = useState(-1);

  // light each step in sequence when the section scrolls into view
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timers: number[] = [];
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      steps.forEach((_, i) => timers.push(window.setTimeout(() => setActive(i), 350 + i * 650)));
      io.disconnect();
    }, { threshold: 0.3 });
    io.observe(el);
    return () => { io.disconnect(); timers.forEach(clearTimeout); timers = []; };
  }, []);

  return (
    <section id="how" className="section">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <span className="eyebrow">How it works</span>
            <h2>Three steps from file to finished</h2>
          </div>
        </Reveal>
        <ol className="flow" ref={ref}>
          <span className="flow-track" aria-hidden="true"><span className="flow-fill" style={{ ["--p" as string]: active < 0 ? 0 : (active + 1) / steps.length }} /></span>
          {steps.map((s, i) => (
            <li key={s.n} className={`card flow-step ${i <= active ? "on" : ""}`}>
              <div className="flow-icon">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={s.icon} /></svg>
              </div>
              <span className="step-n gradient-text">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
