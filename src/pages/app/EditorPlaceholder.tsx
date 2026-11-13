export default function EditorPlaceholder({ title, stage, blurb }: { title: string; stage: string; blurb: string }) {
  return (
    <>
      <div className="page-head"><h1>{title}</h1><p>{blurb}</p></div>
      <section className="panel card">
        <div className="empty">
          <span className="badge soon">{stage}</span>
          <h3>Not built yet</h3>
          <p>This editor is planned for {stage.toLowerCase()}. No processing is available and nothing here is simulated.</p>
        </div>
      </section>
    </>
  );
}
