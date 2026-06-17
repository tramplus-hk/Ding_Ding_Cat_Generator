import { useCallback, useEffect, useRef, useState } from "react";
import type { StickerRecord } from "@sticker-platform/shared";
import { acceptSticker, createSticker, generateSticker, refineSticker, rejectSticker, uploadReferenceImage } from "../lib/api";

const FESTIVALS = [
  { id: "general", label: "General", desc: "general TramPlus sticker with Hong Kong tram culture, city motion, and clean brand energy",
    picks: [
      ["Classic Tram Ride", "riding happily on a classic Hong Kong tram with confident energy"],
      ["City Explorer", "exploring the city with a bright and welcoming expression"],
      ["Bell Helmet Hero", "standing proudly with the signature bell helmet in a clean sticker pose"],
      ["Team Greeting", "waving hello in a friendly greeting pose for a brand sticker"],
      ["Workshop Ready", "holding a simple notebook in a polished creative studio scene"],
      ["Choose for Me", "create a polished general TramPlus sticker with a balanced, versatile pose"],
    ],
  },
  { id: "lunar", label: "Lunar New Year", desc: "Lunar New Year with red lanterns, gold coins, fireworks, lucky symbols",
    picks: [
      ["Lantern Dance", "dancing gracefully with glowing red lanterns and firecrackers"],
      ["Red Envelope", "holding a lucky red envelope, excited expression"],
      ["Lucky Dragon", "riding proudly on a golden lucky dragon"],
      ["Fireworks", "watching spectacular colorful fireworks light up the sky"],
      ["Tangyuan", "eating sweet sticky rice tangyuan balls with a happy smile"],
      ["Cheongsam", "wearing an elegant traditional red cheongsam dress"],
    ],
  },
  { id: "christmas", label: "Christmas", desc: "Christmas with Christmas tree, Santa hat, snow, presents, reindeer",
    picks: [
      ["Santa Hat", "wearing a fluffy red Santa hat, merry and jolly"],
      ["Gift Box", "unwrapping a big Christmas present with excitement"],
      ["Snowman", "building a cheerful snowman in a snowy field"],
      ["Reindeer Ride", "riding Rudolph the red-nosed reindeer through the sky"],
      ["Cookies", "baking Christmas cookies wearing a tiny chef hat"],
      ["Caroling", "singing Christmas carols holding a tiny songbook"],
    ],
  },
  { id: "halloween", label: "Halloween", desc: "Halloween with jack-o-lantern, witch hat, bats, spooky dark night, moon",
    picks: [
      ["Pumpkin", "sitting inside a glowing carved jack-o-lantern"],
      ["Witch Hat", "casting a spell wearing a classic pointed witch hat"],
      ["Bat Wings", "flying with tiny bat wings under a full moon"],
      ["Ghost Costume", "dressed as an adorable ghost costume"],
      ["Spider Web", "tangled in a spooky spider web with a startled face"],
      ["Trick or Treat", "trick or treating holding a candy bucket"],
    ],
  },
  { id: "valentine", label: "Valentine", desc: "Valentine with hearts, roses, love letters, cupid arrow, romance",
    picks: [
      ["Love Letter", "writing a heartfelt love letter with a quill pen"],
      ["Roses", "holding a beautiful bouquet of red roses"],
      ["Cupid Arrow", "struck by a cupid arrow with heart-shaped eyes"],
      ["Chocolates", "presenting an elegant heart-shaped chocolate box"],
      ["Celebration Toast", "toasting with two tiny celebration glasses"],
      ["Heart Cloud", "floating happily on a pink cloud surrounded by hearts"],
    ],
  },
  { id: "midautumn", label: "Mid-Autumn Festival", desc: "Mid-Autumn Festival with full moon, lantern glow, mooncakes, and warm evening colors",
    picks: [
      ["Mooncake Time", "holding a mooncake proudly under the full moon"],
      ["Lantern Walk", "walking with a glowing lantern on a festive evening"],
      ["Moon Gazing", "looking up at a bright full moon with a calm happy smile"],
      ["Harbour Night", "enjoying a moonlit Hong Kong harbour night in sticker style"],
      ["Family Gathering", "celebrating a warm Mid-Autumn gathering with festive details"],
      ["Choose for Me", "create a polished Mid-Autumn sticker with moonlight and lantern details"],
    ],
  },
  { id: "dragonboat", label: "Dragon Boat Festival", desc: "Dragon Boat Festival with dragon boats, bamboo leaf dumplings, splashing water, and racing energy",
    picks: [
      ["Dragon Boat Race", "racing proudly on a dragon boat with energetic motion"],
      ["Rice Dumpling", "holding a traditional rice dumpling wrapped in bamboo leaves"],
      ["Victory Pose", "celebrating a strong finish after a dragon boat race"],
      ["Water Splash", "splashing through the water with dynamic festival energy"],
      ["Team Captain", "leading a dragon boat team with determined focus"],
      ["Choose for Me", "create a polished Dragon Boat Festival sticker with racing energy"],
    ],
  },
  { id: "easter", label: "Easter", desc: "Easter with colorful Easter eggs, bunny ears, spring flowers, pastel colors",
    picks: [
      ["Easter Egg", "carefully decorating a colorful Easter egg"],
      ["Bunny Ears", "hopping around happily wearing fluffy pink bunny ears"],
      ["Cherry Blossoms", "sitting peacefully in a field of cherry blossoms"],
      ["Baby Chick", "cuddling a tiny newly hatched baby chick"],
      ["Candy Hunt", "eagerly finding hidden Easter candies in the grass"],
      ["Pastel Rainbow", "skipping joyfully over a pastel rainbow"],
    ],
  },
  { id: "birthday", label: "Birthday", desc: "birthday celebration with cake, candles, ribbons, confetti, and cheerful party details",
    picks: [
      ["Birthday Cake", "presenting a birthday cake with a cheerful smile"],
      ["Wish Moment", "making a birthday wish beside glowing candles"],
      ["Party Hat", "wearing a neat party hat in a celebratory pose"],
      ["Gift Surprise", "opening a surprise gift box with excitement"],
      ["Celebrate Big", "posing in a bright birthday celebration scene"],
      ["Choose for Me", "create a polished birthday sticker with cheerful celebration details"],
    ],
  },
];

function getGeneratedAssetUrl(filePath: string): string {
  const assetBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith("data/generated/")) {
    return `${assetBaseUrl}/${normalizedPath.replace(/^data\//, "")}`;
  }
  if (normalizedPath.startsWith(".runtime/generated/")) {
    return `${assetBaseUrl}/${normalizedPath.replace(/^\.runtime\//, "runtime/")}`;
  }
  return `${assetBaseUrl}/${normalizedPath}`;
}

function getCandidatePreviewUrl(record: StickerRecord, candidatePath: string, previews: Record<string, string>): string {
  if (previews[candidatePath]) return previews[candidatePath];
  const candidateIndex = record.result?.candidates?.indexOf(candidatePath) ?? -1;
  if (candidateIndex >= 0) {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
    return `${apiBaseUrl}/api/stickers/${record.id}/preview/${candidateIndex}`;
  }
  return getGeneratedAssetUrl(candidatePath);
}

interface HistoryItem {
  prompt: string;
  festival: string;
  quickPick: string;
  format: string;
  time: number;
  record: StickerRecord;
  previews: Record<string, string>;
}

export function GeneratePage() {
  const [festivalId, setFestivalId] = useState("");
  const [quickPick, setQuickPick] = useState("");
  const [format, setFormat] = useState<"SVG" | "GIF">("SVG");
  const [description, setDescription] = useState("");
  const [record, setRecord] = useState<StickerRecord | null>(null);
  const [candidatePreviews, setCandidatePreviews] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<{ fileName: string; dataUrl: string } | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refinementRequirement, setRefinementRequirement] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [generationProgress, setGenerationProgress] = useState<{ current: number; total: number } | null>(null);
  const dragCounterRef = useRef(0);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const currentFestival = FESTIVALS.find((f) => f.id === festivalId) ?? FESTIVALS[0];
  const selectedCandidate = selectedPath ?? record?.result?.selectedPath ?? record?.result?.candidates?.[0] ?? null;
  const resultImageUrl = selectedCandidate ? getCandidatePreviewUrl(record!, selectedCandidate, candidatePreviews) : null;

  function handleFestivalChange(value: string) {
    setFestivalId(value);
    if (!value) return;
    const existing = description.trim();
    const prefix = FESTIVALS.map((f) => f.label + ":").join("|");
    const suffix = existing.replace(new RegExp(`^(${prefix})\\s*`), "");
    setDescription(`${FESTIVALS.find((f) => f.id === value)!.label}: ${suffix || "your prompt goes here"}`);
  }

  function handleQuickPickChange(value: string) {
    setQuickPick(value);
    if (!value) return;
    const festivalLabel = festivalId ? `${FESTIVALS.find((f) => f.id === festivalId)!.label}: ` : "";
    setDescription(festivalLabel + value);
  }

  function handlePhotoSelect(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Reference file must be an image.");
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      setPendingPhoto({ fileName: file.name, dataUrl });
      setPhotoPreview(dataUrl);
    });
    reader.addEventListener("error", () => setError("Failed to read reference image"));
    reader.readAsDataURL(file);
  }

  function removePhoto() {
    setPendingPhoto(null);
    setPhotoPreview(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
  }

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && lightboxImage) {
        setLightboxImage(null);
      }
    },
    [lightboxImage],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [handleEscape]);

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingFile(true);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingFile(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    dragCounterRef.current = 0;

    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      handlePhotoSelect(file);
    }
  }

  function esc(str: string) {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return str.replace(/[&<>"']/g, (s) => map[s]);
  }

  async function handleGenerate() {
    const prompt = description.trim();
    if (!prompt || busy) return;

    const theme = festivalId || "general";
    setBusy(true);
    setError(null);
    setMessage(null);
    setRecord(null);
    setSelectedPath(null);
    setRefinementRequirement("");
    setRejectReason("");
    setCandidatePreviews({});

    try {
      const createdRecord = await createSticker({ format: "svg", theme, description: prompt });

      let refPath: string | undefined;
      let refUrl: string | undefined;
      if (pendingPhoto) {
        const uploaded = await uploadReferenceImage(pendingPhoto.fileName, pendingPhoto.dataUrl, theme, prompt);
        refPath = uploaded.path;
        refUrl = uploaded.blobPathname;
        setPendingPhoto(null);
      }

      const generatedRecord = await generateSticker(createdRecord.id, (_current, _total, candidate, preview) => {
        if (preview) setCandidatePreviews((prev) => ({ ...prev, [candidate]: preview }));
      }, { theme, description: prompt, referenceImagePath: refPath, referenceImageUrl: refUrl });

      setRecord(generatedRecord);
      setSelectedPath(generatedRecord.result?.selectedPath ?? generatedRecord.result?.candidates?.[0] ?? null);
      const selected = generatedRecord.result?.selectedPath ?? generatedRecord.result?.candidates?.[0] ?? null;
      if (selected && candidatePreviews[selected]) {
        setHistory((prev) => [{
          prompt,
          festival: festivalId,
          quickPick,
          format,
          time: Date.now(),
          record: generatedRecord,
          previews: candidatePreviews,
        }, ...prev].slice(0, 8));
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to generate sticker");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerate() {
    if (!record) return;
    const theme = record.theme;

    setError(null);
    setMessage(null);
    setBusy(true);
    setCandidatePreviews({});

    try {
      const generatedRecord = await generateSticker(record.id, (_current, _total, candidate, preview) => {
        if (preview) setCandidatePreviews((prev) => ({ ...prev, [candidate]: preview }));
      }, { theme, description: record.description });

      setRecord(generatedRecord);
      setSelectedPath(generatedRecord.result?.selectedPath ?? generatedRecord.result?.candidates?.[0] ?? null);
      setRefinementRequirement("");
      setMessage("Generated five new candidates.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to regenerate candidates");
    } finally {
      setBusy(false);
    }
  }

  async function handleRefine() {
    if (!record || !selectedCandidate) return;

    if (!refinementRequirement.trim()) {
      setError("Describe what to refine before sending it back to the model.");
      return;
    }

    setError(null);
    setMessage(null);
    setBusy(true);
    setCandidatePreviews({});

    try {
      const refinedRecord = await refineSticker(
        record.id,
        {
          selectedPath: selectedCandidate,
          requirement: refinementRequirement.trim(),
        },
        (_current, _total, candidate, preview) => {
          if (preview) setCandidatePreviews((prev) => ({ ...prev, [candidate]: preview }));
        },
      );

      setRecord(refinedRecord);
      setSelectedPath(refinedRecord.result?.selectedPath ?? refinedRecord.result?.candidates?.[0] ?? null);
      setRefinementRequirement("");
      setMessage("Refined into five new candidates. Pick one or refine again.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to refine selected candidate");
    } finally {
      setBusy(false);
    }
  }

  async function handleDecision(action: "accept" | "reject") {
    if (!record) return;

    setError(null);
    setMessage(null);
    setBusy(true);

    try {
      if (action === "reject") {
        await rejectSticker(record.id, { reason: rejectReason.trim() || undefined });
        setRecord(null);
        setSelectedPath(null);
        setRejectReason("");
        setMessage("Rejected. Ready for a new prompt.");
      } else {
        await acceptSticker(record.id, { selectedPath: selectedCandidate ?? undefined });
        setRecord(null);
        setSelectedPath(null);
        setRefinementRequirement("");
        setRejectReason("");
        setMessage("Accepted and uploaded. Ready for a new prompt.");
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : `Failed to ${action} sticker`);
    } finally {
      setBusy(false);
    }
  }

  function openHistory(index: number) {
    const item = history[index];
    if (!item) return;
    setRecord(item.record);
    setCandidatePreviews(item.previews);
    setFestivalId(item.festival);
    setQuickPick(item.quickPick);
    setDescription(item.prompt);
  }

  return (
    <main
      className="page-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingFile ? (
        <div className="drop-overlay">
          <div className="drop-box">
            <div className="drop-icon">📁</div>
            <p>Drop image here to use as reference</p>
          </div>
        </div>
      ) : null}
      <nav className="topbar">
        <img className="brand-logo" src="/TramPlus_4C_BLK-01.png" alt="TramPlus" />
        <div className="topbar-meta">
          <span>AI Image Generator</span>
        </div>
      </nav>

      <section className="oliver-grid">
        <section className="workbench">
          <span className="eyebrow">Create an image</span>
          <h2 className="card-title">Generate a Ding Ding Cat sticker</h2>

          <textarea
            className="prompt"
            rows={3}
            placeholder="Ding Ding Cat on a Hong Kong tram, clean premium sticker style..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
          />

          <div className="gen-row">
            <div className="gen-options">
              <div className="gen-field">
                <span>Quick Pick</span>
                <select
                  className="gen-select"
                  value={quickPick}
                  onChange={(e) => handleQuickPickChange(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Choose a quick pick</option>
                  {currentFestival.picks.map(([label, prompt]) => (
                    <option key={label} value={prompt}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="gen-field">
                <span>Festival</span>
                <select
                  className="gen-select"
                  value={festivalId}
                  onChange={(e) => handleFestivalChange(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Festival theme</option>
                  {FESTIVALS.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div className="gen-field">
                <span>Format</span>
                <select
                  className="gen-select"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as "SVG" | "GIF")}
                  disabled={busy}
                >
                  <option value="SVG">SVG</option>
                  <option value="GIF">GIF</option>
                </select>
              </div>
            </div>
            <button className="primary-action btn-generate" type="button" onClick={handleGenerate} disabled={busy || !description.trim()}>
              {busy ? (
                <>
                  <span className="btn-spinner" />
                  <span>Generating…</span>
                </>
              ) : (
                <>
                  <span>✦</span>
                  <span>Generate</span>
                </>
              )}
            </button>
          </div>

          <p className="helper-text">Quick Pick helps students start faster on tablet.<br />Festival adds a Ding Ding Cat theme prefix to the prompt.</p>

          {error ? <p className="form-message error">{error}</p> : null}
          {message ? <p className="form-message success">{message}</p> : null}

          <div className="result-shell">
            {busy ? (
              <div className="loading-state">
                <div className="spinner" />
                <p>Generating your image…</p>
              </div>
            ) : record && record.result?.candidates?.length ? (
              <div className="result-view">
                <div className="candidate-grid">
                  {record.result.candidates.map((candidatePath, index) => {
                    const candidateUrl = getCandidatePreviewUrl(record, candidatePath, candidatePreviews);
                    const isSelected = candidatePath === (selectedPath ?? record.result?.selectedPath ?? record.result?.candidates?.[0]);
                    return (
                      <button
                        className={isSelected ? "candidate-card selected" : "candidate-card"}
                        key={candidatePath}
                        type="button"
                        onClick={() => setSelectedPath(candidatePath)}
                      >
                        <span>Candidate {index + 1}</span>
                        <img
                          src={candidateUrl}
                          alt={`Candidate ${index + 1}: ${record.description}`}
                          onDoubleClick={() => setLightboxImage(candidateUrl)}
                        />
                      </button>
                    );
                  })}
                </div>

                <div className="result-meta">
                  <p>{selectedCandidate ? "Selected candidate" : "Choose one candidate"}</p>
                </div>

                <div className="review-grid">
                  <label>
                    Fine-tune requirement
                    <textarea
                      placeholder="e.g. make the lantern bigger, simplify the background, keep the same pose"
                      rows={3}
                      value={refinementRequirement}
                      onChange={(e) => setRefinementRequirement(e.target.value)}
                    />
                  </label>
                  <button className="secondary-cta" type="button" disabled={busy || !selectedCandidate} onClick={() => void handleRefine()}>
                    {busy ? "Refining…" : "Refine selected"}
                  </button>
                </div>

                <div className="review-grid">
                  <label>
                    Reject reason
                    <textarea
                      placeholder="Optional: what went wrong?"
                      rows={2}
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                    />
                  </label>
                  {selectedCandidate ? (
                    <a className="download" href={getCandidatePreviewUrl(record, selectedCandidate, candidatePreviews)} download>
                      Download selected
                    </a>
                  ) : null}
                </div>

                <div className="result-actions">
                  <button className="secondary-cta" type="button" disabled={busy} onClick={() => void handleRegenerate()}>
                    {busy ? "Regenerating…" : "Regenerate five"}
                  </button>
                  <button className="danger-cta" type="button" disabled={busy} onClick={() => void handleDecision("reject")}>
                    Reject
                  </button>
                  <button className="primary-action" type="button" disabled={busy || !selectedCandidate} onClick={() => void handleDecision("accept")}>
                    Accept
                  </button>
                </div>
              </div>
            ) : (
              <div className="result-empty">
                <div className="empty-icon">T+</div>
                <p>Enter a Ding Ding Cat prompt above to see your creation</p>
              </div>
            )}
          </div>
        </section>

        <aside className="history-card">
          <div className="history-head">
            <div>
              <h2>Recent Ding Ding Cat generations</h2>
              <div className="count"><span>{history.length}</span> items</div>
            </div>
          </div>

          <div className="upload-card">
            <div className="upload-copy">
              <strong>Upload your own photo</strong>
              <small>Optional: students can add a reference photo before generating their Ding Ding Cat design.</small>
            </div>
            <div className="upload-row">
              <button className="upload-button" type="button" onClick={() => photoInputRef.current?.click()}>Choose photo</button>
              <div className="upload-preview">
                {photoPreview ? (
                  <img src={photoPreview} alt="Selected photo preview" />
                ) : (
                  "No photo selected yet"
                )}
              </div>
            </div>
            <input ref={photoInputRef} className="hidden-input" type="file" accept="image/*" onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handlePhotoSelect(file);
            }} />
            {photoPreview ? (
              <button className="upload-remove-btn" type="button" onClick={removePhoto}>Remove photo</button>
            ) : null}
          </div>

          {history.length === 0 ? (
            <div className="empty-history">No generations yet. Your Ding Ding Cat results will appear here as clickable thumbnails.</div>
          ) : (
            <div className="thumb-grid">
              {history.map((item, index) => (
                <button className="thumb" type="button" key={item.time} onClick={() => openHistory(index)} aria-label={`Open ${item.prompt}`}>
                  <div className="mini" />
                  <div className="thumb-label">{esc(item.prompt.slice(0, 40))}{item.prompt.length > 40 ? "…" : ""}</div>
                </button>
              ))}
            </div>
          )}
        </aside>
      </section>

      <footer className="footer-mark">TramPlus Ding Ding Cat AI Image Generator · Built for a crisp, premium brand experience</footer>

      {lightboxImage ? (
        <div className="lightbox-overlay" onClick={() => setLightboxImage(null)}>
          <button className="lightbox-close" onClick={() => setLightboxImage(null)} aria-label="Close lightbox">✕</button>
          <img className="lightbox-image" src={lightboxImage} alt="Enlarged sticker" onClick={(e) => e.stopPropagation()} />
        </div>
      ) : null}
    </main>
  );
}
