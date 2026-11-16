import { Link } from "react-router-dom";
import Reveal from "../ui/Reveal";
import { ALLOWED_LABEL } from "../../lib/files";

/** Landing entry point to the real, private upload workspace. Uploads only happen inside the signed-in app. */
export default function UploadSection() {
  return (
    <section id="upload" className="section">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <span className="eyebrow">Upload workspace</span>
            <h2>Your files, private to your account</h2>
            <p>Log in to upload images, videos and documents. Only you can see, download or delete them.</p>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <div className="upload card">
            <Link to="/workspace" className="dropzone" aria-label="Open the upload workspace">
              <div className="dz-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
              </div>
              <p className="dz-title">Open your upload workspace</p>
              <p className="dz-sub">You will be asked to <span className="link">log in</span> first</p>
              <div className="dz-types"><span className="dz-limit">{ALLOWED_LABEL} · images up to 20 MB, video and documents up to 50 MB</span></div>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
