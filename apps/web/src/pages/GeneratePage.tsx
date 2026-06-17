import type { CSSProperties, FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StickerRecord } from "@sticker-platform/shared";
import { acceptSticker, createSticker, generateSticker, refineSticker, rejectSticker, uploadReferenceImage } from "../lib/api";

const FESTIVALS = [
  {
    id: "general",
    label: "General",
    color: "#4DB969",
    glow: "#EEF9F1",
    hint: "Classic tram rides, city scenes, everyday charm",
    desc: "general TramPlus sticker with Hong Kong tram culture, city motion, and clean brand energy",
    picks: [
      ["Classic Tram Ride", "riding happily on a classic Hong Kong tram with confident energy"],
      ["City Explorer", "exploring the city with a bright and welcoming expression"],
      ["Bell Helmet Hero", "standing proudly with the signature bell helmet in a clean sticker pose"],
      ["Team Greeting", "waving hello in a friendly greeting pose for a brand sticker"],
      ["Workshop Ready", "holding a simple notebook in a polished creative studio scene"],
      ["Choose for Me", "create a polished general TramPlus sticker with a balanced, versatile pose"],
    ],
  },
  {
    id: "lunar",
    label: "Lunar New Year",
    color: "#C75948",
    glow: "#FFF4F1",
    hint: "Red envelopes, lanterns, gold coins, fireworks",
    desc: "Lunar New Year with red lanterns, gold coins, fireworks, lucky symbols",
    picks: [
      ["Lantern Dance", "dancing gracefully with glowing red lanterns and firecrackers"],
      ["Red Envelope", "holding a lucky red envelope, excited expression"],
      ["Lucky Dragon", "riding proudly on a golden lucky dragon"],
      ["Fireworks", "watching spectacular colorful fireworks light up the sky"],
      ["Tangyuan", "eating sweet sticky rice tangyuan balls with a happy smile"],
      ["Cheongsam", "wearing an elegant traditional red cheongsam dress"],
    ],
  },
  {
    id: "christmas",
    label: "Christmas",
    color: "#4DB969",
    glow: "#EEF9F1",
    hint: "Santa hat, Christmas tree, snow, presents",
    desc: "Christmas with Christmas tree, Santa hat, snow, presents, reindeer",
    picks: [
      ["Santa Hat", "wearing a fluffy red Santa hat, merry and jolly"],
      ["Gift Box", "unwrapping a big Christmas present with excitement"],
      ["Snowman", "building a cheerful snowman in a snowy field"],
      ["Reindeer Ride", "riding Rudolph the red-nosed reindeer through the sky"],
      ["Cookies", "baking Christmas cookies wearing a tiny chef hat"],
      ["Caroling", "singing Christmas carols holding a tiny songbook"],
    ],
  },
  {
    id: "halloween",
    label: "Halloween",
    color: "#FFB34F",
    glow: "#FFF7EA",
    hint: "Pumpkin, witch hat, bats, spooky night",
    desc: "Halloween with jack-o-lantern, witch hat, bats, spooky dark night, moon",
    picks: [
      ["Pumpkin", "sitting inside a glowing carved jack-o-lantern"],
      ["Witch Hat", "casting a spell wearing a classic pointed witch hat"],
      ["Bat Wings", "flying with tiny bat wings under a full moon"],
      ["Ghost Costume", "dressed as an adorable ghost costume"],
      ["Spider Web", "tangled in a spooky spider web with a startled face"],
      ["Trick or Treat", "trick or treating holding a candy bucket"],
    ],
  },
  {
    id: "valentine",
    label: "Valentine",
    color: "#B94D9C",
    glow: "#FDF2FA",
    hint: "Hearts, roses, love letters, romance",
    desc: "Valentine with hearts, roses, love letters, cupid arrow, romance",
    picks: [
      ["Love Letter", "writing a heartfelt love letter with a quill pen"],
      ["Roses", "holding a beautiful bouquet of red roses"],
      ["Cupid Arrow", "struck by a cupid arrow with heart-shaped eyes"],
      ["Chocolates", "presenting an elegant heart-shaped chocolate box"],
      ["Celebration Toast", "toasting with two tiny celebration glasses"],
      ["Heart Cloud", "floating happily on a pink cloud surrounded by hearts"],
    ],
  },
  {
    id: "easter",
    label: "Easter",
    color: "#48B6C7",
    glow: "#EFFBFC",
    hint: "Easter eggs, bunny ears, spring flowers, pastels",
    desc: "Easter with colorful Easter eggs, bunny ears, spring flowers, pastel colors",
    picks: [
      ["Easter Egg", "carefully decorating a colorful Easter egg"],
      ["Bunny Ears", "hopping around happily wearing fluffy pink bunny ears"],
      ["Cherry Blossoms", "sitting peacefully in a field of cherry blossoms"],
      ["Baby Chick", "cuddling a tiny newly hatched baby chick"],
      ["Candy Hunt", "eagerly finding hidden Easter candies in the grass"],
      ["Pastel Rainbow", "skipping joyfully over a pastel rainbow"],
    ],
  },
  {
    id: "midautumn",
    label: "Mid-Autumn Festival",
    color: "#F29B38",
    glow: "#FFF7E9",
    hint: "Mooncakes, lantern glow, full moon, night sky",
    desc: "Mid-Autumn Festival with full moon, lantern glow, mooncakes, and warm evening colors",
    picks: [
      ["Mooncake Time", "holding a mooncake proudly under the full moon"],
      ["Lantern Walk", "walking with a glowing lantern on a festive evening"],
      ["Moon Gazing", "looking up at a bright full moon with a calm happy smile"],
      ["Harbour Night", "enjoying a moonlit Hong Kong harbour night in sticker style"],
      ["Family Gathering", "celebrating a warm Mid-Autumn gathering with festive details"],
      ["Choose for Me", "create a polished Mid-Autumn sticker with moonlight and lantern details"],
    ],
  },
  {
    id: "dragonboat",
    label: "Dragon Boat Festival",
    color: "#2E8F74",
    glow: "#EDF9F5",
    hint: "Dragon boats, bamboo leaves, racing spirit, water",
    desc: "Dragon Boat Festival with dragon boats, bamboo leaf dumplings, splashing water, and racing energy",
    picks: [
      ["Dragon Boat Race", "racing proudly on a dragon boat with energetic motion"],
      ["Rice Dumpling", "holding a traditional rice dumpling wrapped in bamboo leaves"],
      ["Victory Pose", "celebrating a strong finish after a dragon boat race"],
      ["Water Splash", "splashing through the water with dynamic festival energy"],
      ["Team Captain", "leading a dragon boat team with determined focus"],
      ["Choose for Me", "create a polished Dragon Boat Festival sticker with racing energy"],
    ],
  },
  {
    id: "birthday",
    label: "Birthday",
    color: "#4DA9FF",
    glow: "#EEF6FF",
    hint: "Cake, candles, ribbons, celebration",
    desc: "birthday celebration with cake, candles, ribbons, confetti, and cheerful party details",
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

function getRequiredValue(formData: FormData, fieldName: string): string {
  return String(formData.get(fieldName) ?? "").trim();
}

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
  if (previews[candidatePath]) {
    return previews[candidatePath];
  }

  const candidateIndex = record.result?.candidates?.indexOf(candidatePath) ?? -1;
  if (candidateIndex >= 0) {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
    return `${apiBaseUrl}/api/stickers/${record.id}/preview/${candidateIndex}`;
  }

  return getGeneratedAssetUrl(candidatePath);
}

export function GeneratePage() {
  const [festival, setFestival] = useState(FESTIVALS[0]);
  const [isFestivalOpen, setIsFestivalOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [record, setRecord] = useState<StickerRecord | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refinementRequirement, setRefinementRequirement] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeAction, setActiveAction] = useState<"accept" | "reject" | "regenerate" | "refine" | null>(null);
  const [generationProgress, setGenerationProgress] = useState<{ current: number; total: number } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [referenceImagePath, setReferenceImagePath] = useState<string | null>(null);
  const [referenceImagePreview, setReferenceImagePreview] = useState<string | null>(null);
  const [pendingReferenceData, setPendingReferenceData] = useState<{ fileName: string; dataUrl: string } | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [candidatePreviews, setCandidatePreviews] = useState<Record<string, string>>({});
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const candidates = record?.result?.candidates ?? [];
  const selectedCandidate = selectedPath ?? record?.result?.selectedPath ?? record?.result?.localPath ?? candidates[0] ?? null;

  function applyPick(prompt: string) {
    setDescription(prompt);
    setIsFestivalOpen(false);
  }

  async function storeReferenceFile(file: File) {
    setError(null);

    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.addEventListener("load", () => resolve(reader.result as string));
        reader.addEventListener("error", () => reject(new Error("Failed to read file")));
        reader.readAsDataURL(file);
      });

      setPendingReferenceData({ fileName: file.name, dataUrl });
      setReferenceImagePreview(dataUrl);
      setReferenceImagePath(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to read reference image");
    }
  }

  function removeReferenceImage() {
    setReferenceImagePath(null);
    setReferenceImagePreview(null);
    setPendingReferenceData(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function ensureReferenceUploaded(theme: string, description: string): Promise<string | undefined> {
    if (pendingReferenceData) {
      const { fileName, dataUrl } = pendingReferenceData;
      const { path } = await uploadReferenceImage(fileName, dataUrl, theme, description);
      setReferenceImagePath(path);
      setPendingReferenceData(null);
      return path;
    }
    return referenceImagePath ?? undefined;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsSubmitting(true);
    setRecord(null);
    setSelectedPath(null);
    setRefinementRequirement("");
    setRejectReason("");
    setCandidatePreviews({});

    const formData = new FormData(event.currentTarget);
    const theme = festival.id;
    const description = getRequiredValue(formData, "description");

    if (!description) {
      setError("Description is required.");
      setIsSubmitting(false);
      return;
    }

    try {
      const createdRecord = await createSticker({
        format: "svg",
        theme,
        description,
      });
      const uploadedPath = await ensureReferenceUploaded(theme, description);
      setIsSubmitting(false);
      setGenerationProgress({ current: 0, total: 5 });

      const generatedRecord = await generateSticker(createdRecord.id, (current, total, candidate, preview) => {
        setGenerationProgress({ current, total });
        if (preview) {
          setCandidatePreviews((prev) => ({ ...prev, [candidate]: preview }));
        }
      }, uploadedPath, { theme: festival.id, description });

      setRecord(generatedRecord);
      setSelectedPath(generatedRecord.result?.selectedPath ?? generatedRecord.result?.candidates?.[0] ?? null);
      setMessage("Pick the best candidate, regenerate all five, or refine the selected one.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to create sticker request");
    } finally {
      setIsSubmitting(false);
      setGenerationProgress(null);
    }
  }

  async function handleRegenerate() {
    if (!record) {
      return;
    }

    setError(null);
    setMessage(null);
    setActiveAction("regenerate");
    setGenerationProgress({ current: 0, total: 5 });
    setCandidatePreviews({});

    try {
      const uploadedPath = await ensureReferenceUploaded(record.theme, record.description);
      const generatedRecord = await generateSticker(record.id, (current, total, candidate, preview) => {
        setGenerationProgress({ current, total });
        if (preview) {
          setCandidatePreviews((prev) => ({ ...prev, [candidate]: preview }));
        }
      }, uploadedPath, { theme: record.theme, description: record.description });
      setRecord(generatedRecord);
      setSelectedPath(generatedRecord.result?.selectedPath ?? generatedRecord.result?.candidates?.[0] ?? null);
      setRefinementRequirement("");
      setMessage("Generated five new candidates.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to regenerate candidates");
    } finally {
      setActiveAction(null);
      setGenerationProgress(null);
    }
  }

  async function handleRefine() {
    if (!record || !selectedCandidate) {
      return;
    }

    if (!refinementRequirement.trim()) {
      setError("Describe what to refine before sending it back to the model.");
      return;
    }

    setError(null);
    setMessage(null);
    setActiveAction("refine");
    setGenerationProgress({ current: 0, total: 5 });
    setCandidatePreviews({});

    try {
      const uploadedPath = await ensureReferenceUploaded(record.theme, record.description);
      const refinedRecord = await refineSticker(
        record.id,
        {
          selectedPath: selectedCandidate,
          requirement: refinementRequirement.trim(),
          referenceImagePath: uploadedPath,
        },
        (current, total, candidate, preview) => {
          setGenerationProgress({ current, total });
          if (preview) {
            setCandidatePreviews((prev) => ({ ...prev, [candidate]: preview }));
          }
        },
      );
      setRecord(refinedRecord);
      setSelectedPath(refinedRecord.result?.selectedPath ?? refinedRecord.result?.candidates?.[0] ?? null);
      setRefinementRequirement("");
      setMessage("Refined into five new candidates. Pick one or refine again.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to refine selected candidate");
    } finally {
      setActiveAction(null);
      setGenerationProgress(null);
    }
  }

  async function handleDecision(action: "accept" | "reject") {
    if (!record) {
      return;
    }

    setError(null);
    setMessage(null);
    setActiveAction(action);

    try {
      if (action === "reject") {
        await rejectSticker(record.id, { reason: rejectReason.trim() || undefined });
        window.location.reload();
      } else {
        const selectedPreview = selectedCandidate ? candidatePreviews[selectedCandidate] : undefined;
        await acceptSticker(record.id, {
          selectedPath: selectedCandidate ?? undefined,
          imageData: selectedPreview?.startsWith("data:") ? selectedPreview : undefined,
        });
        setRecord(null);
        setSelectedPath(null);
        setDescription("");
        setRefinementRequirement("");
        setRejectReason("");
        setMessage("Accepted and uploaded. The local JSON cache was removed.");
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : `Failed to ${action} sticker`);
    } finally {
      setActiveAction(null);
    }
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
      storeReferenceFile(file);
    }
  }

  return (
    <main
      className="page-shell"
      style={{ "--festival-color": festival.color, "--festival-glow": festival.glow } as CSSProperties}
      onClick={() => setIsFestivalOpen(false)}
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
      <div className="brand-wash" />
      <nav className="topbar" onClick={(event) => event.stopPropagation()}>
        <img className="brand-logo" src="/tramplus-green.svg" alt="TramPlus" />
        <div className="topbar-meta">
          <span>Ding Ding Cat Studio</span>
          <a href="/history">History</a>
        </div>
      </nav>

      <section className="hero-grid">
        <div className="hero-panel">
          <span className="eyebrow">TramPlus Creative Tool</span>
          <h1>Create clean Ding Ding Cat stickers.</h1>
          <p>Fast, friendly, and ready for TramPlus.</p>
          <div className="brand-note">
            <span>Brand</span>
            <img className="brand-logo inverse" src="/tramplus-white.svg" alt="TramPlus" />
            <img className="tagline-image" src="/tagline-black.png" alt="where engineering excellence meets education" />
          </div>
        </div>

        <form className="workbench" onSubmit={handleSubmit} onClick={(event) => event.stopPropagation()}>
          <div className="card-header">
            <div>
              <span className="eyebrow">Create</span>
              <h2>Sticker Brief</h2>
            </div>
            <div className="status-pill">5 candidates</div>
          </div>

          <div className="field-grid">
            <div className="field-block dropdown-block">
              <label>Festival Style</label>
              <button
                className={isFestivalOpen ? "select-button open" : "select-button"}
                type="button"
                onClick={() => setIsFestivalOpen((open) => !open)}
                style={{ borderColor: isFestivalOpen ? festival.color : undefined, boxShadow: isFestivalOpen ? `0 0 0 4px ${festival.color}22` : undefined }}
              >
                <span><i style={{ background: festival.color }} />{festival.label}</span>
                <b className={isFestivalOpen ? "rotated" : ""}>⌄</b>
              </button>
              {isFestivalOpen ? (
                <div className="menu-list festival-menu">
                  {FESTIVALS.map((item) => (
                    <button
                      className={item.id === festival.id ? "selected" : ""}
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setFestival(item);
                        setIsFestivalOpen(false);
                      }}
                      style={{ color: item.id === festival.id ? item.color : undefined, background: item.id === festival.id ? item.glow : undefined }}
                    >
                      <span><i style={{ background: item.color }} />{item.label}</span>
                      {item.id === festival.id ? <span>✓</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="field-block">
              <label>Quick Pick</label>
              <div className="quick-picks">
                {festival.picks.map(([label, prompt]) => (
                  <button key={label} type="button" disabled={isSubmitting} onClick={() => applyPick(prompt)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            </div>

            <div className="field-block">
              <label>Reference Image (Optional)</label>
              <div className="upload-area">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="upload-input"
                  disabled={isSubmitting}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) {
                      storeReferenceFile(file);
                    }
                  }}
                />
                {referenceImagePreview ? (
                  <div className="upload-preview">
                    <img src={referenceImagePreview} alt="Reference preview" />
                    <button
                      type="button"
                      className="upload-remove"
                      onClick={() => removeReferenceImage()}
                      aria-label="Remove reference image"
                    >
                      ✕
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="field-block prompt-block">
            <label>Describe Your Sticker</label>
            <div className="prompt-row">
              <input
                name="description"
                placeholder={`Example: ${festival.picks[0][1]}`}
                required
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={isSubmitting}
              />
              <button className="primary-action" type="submit" disabled={isSubmitting || !description.trim()}>
                {isSubmitting ? "Generating" : "Generate five"}
              </button>
            </div>
            <p className="helper-text">Quick picks fill the prompt. The review panel keeps refinement, rejection, and upload connected.</p>
          </div>

          <div className="hint-strip" style={{ background: festival.glow, borderColor: festival.color, color: festival.color }}>
            <span style={{ background: festival.color }} />{festival.hint}
          </div>

          {error ? <p className="form-message error full-width">{error}</p> : null}
          {message ? <p className="form-message success full-width">{message}</p> : null}
        </form>
      </section>

      <section className="studio-grid" onClick={() => setIsFestivalOpen(false)}>
        <div className="preview-card" style={{ borderColor: record || isSubmitting || generationProgress ? festival.color : undefined, boxShadow: record || isSubmitting || generationProgress ? `0 0 0 5px ${festival.color}14, var(--shadow-card)` : undefined }}>
          <div className="preview-topline">
            <span>Preview Canvas</span>
            <strong style={{ color: festival.color }}>{festival.label}</strong>
          </div>

          <div className="preview-stage">
            {isSubmitting || generationProgress ? (
              <div className="loading-state">
                <div className="cat-bounce cat-mark">🐱</div>
                {generationProgress && generationProgress.current > 0 ? (
                  <p style={{ color: festival.color }}>Candidates ready: {generationProgress.current} / {generationProgress.total}</p>
                ) : (
                  <p style={{ color: festival.color }}>Drawing Ding Ding Cat</p>
                )}
                <div className="dot-row">{[0, 1, 2].map((item) => <span key={item} style={{ background: festival.color, animationDelay: `${item * 0.15}s` }} />)}</div>
              </div>
            ) : null}

            {!isSubmitting && !generationProgress && !record ? (
              <div className="empty-state"><div className="cat-mark">🐱</div><p>Your generated sticker candidates will appear here.</p></div>
            ) : null}

            {!isSubmitting && !generationProgress && record ? (
              <div className="result-display">
                <div className="candidate-grid">
                  {candidates.map((candidatePath, index) => {
                    const candidateUrl = getCandidatePreviewUrl(record, candidatePath, candidatePreviews);
                    const isSelected = candidatePath === selectedCandidate;

                    return (
                      <button className={isSelected ? "candidate-card selected" : "candidate-card"} key={candidatePath} type="button" onClick={() => setSelectedPath(candidatePath)}>
                        <span>Candidate {index + 1}</span>
                        {candidatePath.endsWith(".svg") || candidatePath.endsWith(".png") || candidatePath.endsWith(".jpg") || candidatePath.endsWith(".webp") ? (
                          <img src={candidateUrl} alt={`Candidate ${index + 1}: ${record.description}`} onDoubleClick={() => setLightboxImage(candidateUrl)} />
                        ) : (
                          <strong>{candidatePath}</strong>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="result-meta"><p>{selectedCandidate ? "Selected candidate" : "Choose one candidate"}</p><span>{selectedCandidate ?? "No candidate selected yet"}</span></div>

                <div className="review-grid">
                  <label>
                    Fine-tune requirement
                    <textarea placeholder="Make the lantern bigger, simplify the background, keep the same pose" rows={3} value={refinementRequirement} onChange={(event) => setRefinementRequirement(event.target.value)} />
                  </label>
                  <button className="secondary-cta" type="button" disabled={activeAction !== null || !selectedCandidate} onClick={() => void handleRefine()}>{activeAction === "refine" ? "Refining" : "Refine selected"}</button>
                </div>

                <div className="review-grid">
                  <label>
                    Reject reason
                    <textarea placeholder="Optional: what went wrong?" rows={2} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
                  </label>
                  {selectedCandidate ? <a className="download-button" href={getCandidatePreviewUrl(record, selectedCandidate, candidatePreviews)} download>Download selected</a> : null}
                </div>

                <div className="result-actions">
                  <button className="secondary-cta" type="button" disabled={activeAction !== null} onClick={() => void handleRegenerate()}>{activeAction === "regenerate" ? "Regenerating" : "Regenerate five"}</button>
                  <button className="danger-cta" type="button" disabled={activeAction !== null} onClick={() => void handleDecision("reject")}>{activeAction === "reject" ? "Rejecting" : "Reject"}</button>
                  <button className="primary-action" type="button" disabled={activeAction !== null || !selectedCandidate} onClick={() => void handleDecision("accept")}>{activeAction === "accept" ? "Uploading" : "Accept"}</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {lightboxImage ? (
        <div className="lightbox-overlay" onClick={() => setLightboxImage(null)}>
          <button className="lightbox-close" onClick={() => setLightboxImage(null)} aria-label="Close lightbox">✕</button>
          <img className="lightbox-image" src={lightboxImage} alt="Enlarged sticker" onClick={(event) => event.stopPropagation()} />
        </div>
      ) : null}

      <footer className="footer-mark"><img className="footer-logo" src="/tramplus-green.svg" alt="TramPlus" /><span>where engineering excellence meets education</span></footer>
    </main>
  );
}
