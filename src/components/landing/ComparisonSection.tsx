import Reveal from "../ui/Reveal";
import CompareSlider from "../compare/CompareSlider";
import DemoScene from "../compare/DemoScene";

export default function ComparisonSection() {
  return (
    <section id="compare" className="section">
      <div className="container compare-wrap">
        <Reveal>
          <div className="section-head">
            <span className="eyebrow">Before and after</span>
            <h2>See the difference, side by side</h2>
            <p>Drag the handle, tap the image, or use the arrow keys. The same comparison control will be used for real results in the editor.</p>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div className="demo-frame demo-large">
            <CompareSlider
              aspect="16 / 8"
              before={<DemoScene marked />}
              after={<DemoScene marked={false} />}
            />
          </div>
          <p className="demo-caption">Illustration for demonstration. It is not the output of a processing engine.</p>
        </Reveal>
      </div>
    </section>
  );
}
