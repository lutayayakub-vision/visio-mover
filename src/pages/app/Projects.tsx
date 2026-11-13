export default function Projects() {
  return (
    <>
      <div className="page-head"><h1>My Projects</h1><p>Everything you edit will be listed here, visible only to you.</p></div>
      <section className="panel card">
        <div className="empty">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          <h3>No projects yet</h3>
          <p>Project storage is built in Stage 3. Nothing has been uploaded.</p>
        </div>
      </section>
    </>
  );
}
