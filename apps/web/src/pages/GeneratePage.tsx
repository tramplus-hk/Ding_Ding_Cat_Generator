import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createSticker } from "../lib/api";

function getRequiredValue(formData: FormData, fieldName: string): string {
  return String(formData.get(fieldName) ?? "").trim();
}

export function GeneratePage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);
    const theme = getRequiredValue(formData, "theme");
    const category = getRequiredValue(formData, "category");
    const stickerContent = getRequiredValue(formData, "stickerContent");
    const description = getRequiredValue(formData, "description");

    if (!theme || !category || !stickerContent || !description) {
      setError("Theme, category, sticker content, and description are required.");
      setIsSubmitting(false);
      return;
    }

    try {
      const record = await createSticker({
        type: formData.get("type") === "gif" ? "gif" : "svg",
        theme,
        category,
        stickerContent,
        description,
      });

      navigate(`/stickers/${record.id}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to create sticker request");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <p className="eyebrow">Step 1</p>
        <h2>Create Sticker Request</h2>
        <p>Create a local JSON cache record. Generation still uses a Nano Banana 2 placeholder adapter.</p>
      </div>

      <form className="form-grid" onSubmit={handleSubmit}>
        <label>
          Type
          <select name="type" defaultValue="svg">
            <option value="svg">SVG</option>
            <option value="gif">GIF</option>
          </select>
        </label>

        <label>
          Theme
          <input name="theme" placeholder="Cute animal" required />
        </label>

        <label>
          Category
          <input name="category" placeholder="animals" required />
        </label>

        <label>
          Sticker Content
          <input name="stickerContent" placeholder="cat-coffee" required />
        </label>

        <label className="full-width">
          Description
          <textarea name="description" placeholder="A cute cat holding a coffee cup" rows={6} required />
        </label>

        {error ? <p className="form-message error full-width">{error}</p> : null}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : "Create Local JSON"}
        </button>
      </form>
    </section>
  );
}
