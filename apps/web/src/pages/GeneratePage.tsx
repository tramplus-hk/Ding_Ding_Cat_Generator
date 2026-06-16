export function GeneratePage() {
  return (
    <section className="panel">
      <div className="section-heading">
        <p className="eyebrow">Step 1</p>
        <h2>Create Sticker Request</h2>
        <p>Skeleton form for collecting sticker prompt JSON before local cache and generation are implemented.</p>
      </div>

      <form className="form-grid">
        <label>
          Type
          <select name="type" defaultValue="svg">
            <option value="svg">SVG</option>
            <option value="gif">GIF</option>
          </select>
        </label>

        <label>
          Theme
          <input name="theme" placeholder="Cute animal" />
        </label>

        <label>
          Category
          <input name="category" placeholder="animals" />
        </label>

        <label>
          Sticker Content
          <input name="stickerContent" placeholder="cat-coffee" />
        </label>

        <label className="full-width">
          Description
          <textarea name="description" placeholder="A cute cat holding a coffee cup" rows={6} />
        </label>

        <button type="button">Generate Placeholder</button>
      </form>
    </section>
  );
}
