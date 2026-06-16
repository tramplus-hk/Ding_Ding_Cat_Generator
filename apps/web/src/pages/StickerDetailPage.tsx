import { useParams } from "react-router-dom";

export function StickerDetailPage() {
  const { id } = useParams();

  return (
    <section className="panel">
      <div className="section-heading">
        <p className="eyebrow">Review</p>
        <h2>Sticker Detail</h2>
        <p>Placeholder detail screen for sticker record `{id}`.</p>
      </div>
      <div className="preview-box">Generated sticker preview will appear here.</div>
    </section>
  );
}
