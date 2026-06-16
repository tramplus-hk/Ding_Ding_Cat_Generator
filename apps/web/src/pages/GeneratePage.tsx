import type { CSSProperties, FormEvent } from "react";
import { useState } from "react";
import type { StickerRecord } from "@sticker-platform/shared";
import { acceptSticker, createSticker, generateSticker, rejectSticker } from "../lib/api";

const FESTIVALS = [
  {
    id: "lunar",
    label: "🧧 Lunar New Year",
    color: "#ef4444",
    glow: "rgba(239, 68, 68, 0.2)",
    dot: "#fca5a5",
    hint: "Red envelopes, lanterns, gold coins & fireworks",
    desc: "red lanterns, gold coins, fireworks, lucky symbols",
    picks: [
      ["🏮 Lantern dance", "dancing with red lanterns"],
      ["🧧 Red envelope", "holding a lucky red envelope"],
      ["🐲 Lucky dragon", "riding a golden dragon"],
      ["🎆 Fireworks", "watching fireworks"],
      ["🍡 Tangyuan", "eating tangyuan"],
      ["👘 Cheongsam", "wearing a cheongsam dress"],
    ],
  },
  {
    id: "christmas",
    label: "🎄 Christmas",
    color: "#22c55e",
    glow: "rgba(34, 197, 94, 0.2)",
    dot: "#86efac",
    hint: "Christmas trees, santa hat, snow & presents",
    desc: "Christmas tree, santa hat, snow, presents, reindeer",
    picks: [
      ["🎅 Santa hat", "wearing a santa hat"],
      ["🎁 Gift", "unwrapping a present"],
      ["⛄ Snowman", "building a snowman"],
      ["🦌 Reindeer", "riding Rudolph"],
      ["🍪 Cookies", "baking Christmas cookies"],
      ["🎶 Caroling", "singing carols"],
    ],
  },
  {
    id: "halloween",
    label: "🎃 Halloween",
    color: "#f97316",
    glow: "rgba(249, 115, 22, 0.2)",
    dot: "#fdba74",
    hint: "Pumpkins, witch hats, bats & spooky night",
    desc: "jack-o-lantern, witch hat, bats, spooky night moon",
    picks: [
      ["🎃 Pumpkin", "inside a glowing pumpkin"],
      ["🧙 Witch", "wearing a witch hat"],
      ["🦇 Bats", "flying with bat wings"],
      ["👻 Ghost", "dressed as a ghost"],
      ["🕷 Spider", "tangled in a spider web"],
      ["🍬 Candy", "trick or treating"],
    ],
  },
  {
    id: "valentine",
    label: "💝 Valentine",
    color: "#ec4899",
    glow: "rgba(236, 72, 153, 0.2)",
    dot: "#f9a8d4",
    hint: "Hearts, roses, love letters & romance",
    desc: "hearts, roses, love letters, cupid arrow, romance",
    picks: [
      ["💌 Letter", "writing a love letter"],
      ["🌹 Roses", "holding red roses"],
      ["💘 Cupid", "hit by cupid arrow"],
      ["🍫 Chocolates", "giving chocolates"],
      ["🥂 Cheers", "toasting champagne"],
      ["💕 Hearts", "floating with hearts"],
    ],
  },
  {
    id: "easter",
    label: "🐣 Easter",
    color: "#a78bfa",
    glow: "rgba(167, 139, 250, 0.2)",
    dot: "#c4b5fd",
    hint: "Easter eggs, bunny ears, spring flowers & pastels",
    desc: "Easter eggs, bunny ears, spring flowers, pastel colors",
    picks: [
      ["🥚 Easter egg", "decorating an Easter egg"],
      ["🐰 Bunny", "wearing bunny ears"],
      ["🌸 Flowers", "in cherry blossoms"],
      ["🐤 Chick", "holding a baby chick"],
      ["🍭 Candy hunt", "finding candy"],
      ["🌈 Rainbow", "hopping over rainbow"],
    ],
  },
];

function getRequiredValue(formData: FormData, fieldName: string): string {
  return String(formData.get(fieldName) ?? "").trim();
}

export function GeneratePage() {
  const [festival, setFestival] = useState(FESTIVALS[0]);
  const [isFestivalOpen, setIsFestivalOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [record, setRecord] = useState<StickerRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeAction, setActiveAction] = useState<"accept" | "reject" | null>(null);

  const generatedAssetUrl = record?.result?.localPath ? `/${record.result.localPath.replace(/^data\//, "")}` : null;

  function applyPick(prompt: string) {
    setDescription(prompt);
    setIsFestivalOpen(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsSubmitting(true);
    setRecord(null);

    const formData = new FormData(event.currentTarget);
    const theme = `${festival.label}: ${festival.desc}`;
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
      const generatedRecord = await generateSticker(createdRecord.id);

      setRecord(generatedRecord);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to create sticker request");
    } finally {
      setIsSubmitting(false);
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
        setRecord(await rejectSticker(record.id));
        setMessage("Rejected. The local JSON remains available in history for retry or review.");
      } else {
        await acceptSticker(record.id);
        setRecord(null);
        setDescription("");
        setMessage("Accepted and uploaded. The local JSON cache was removed.");
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : `Failed to ${action} sticker`);
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <section className="generator-card" style={{ "--festival-color": festival.color, "--festival-glow": festival.glow } as CSSProperties}>
      <div className="ding-hero">
        <h1>🐱 Ding Ding Cat Sticker Generator</h1>
        <p>Describe a cat sticker and let AI bring it to life</p>
      </div>

      <form className="ding-form" onSubmit={handleSubmit}>
        <div>
          <div className="field-label">Festival style</div>
          <div className="festival-picker">
            <button className="festival-trigger" type="button" onClick={() => setIsFestivalOpen((open) => !open)}>
              <span>{festival.label}</span>
              <span className={isFestivalOpen ? "chevron open" : "chevron"}>▼</span>
            </button>
            {isFestivalOpen ? (
              <div className="festival-menu">
                {FESTIVALS.map((item) => (
                  <button
                    className={item.id === festival.id ? "festival-option active" : "festival-option"}
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setFestival(item);
                      setIsFestivalOpen(false);
                    }}
                  >
                    <span>{item.label}</span>
                    {item.id === festival.id ? <span>✓</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="festival-hint">✨ {festival.hint}</div>

        <div>
          <div className="field-label">Describe your sticker</div>
          <div className="prompt-row">
            <input
              name="description"
              placeholder={`e.g. ${festival.picks[0][1]}`}
              required
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onClick={() => setIsFestivalOpen(false)}
            />
            <button className="primary-button" type="submit" disabled={isSubmitting || !description.trim()}>
              {isSubmitting ? "⏳ Generate" : "✦ Generate"}
            </button>
          </div>
        </div>

        <div>
          <div className="field-label">Quick picks</div>
          <div className="quick-picks">
            {festival.picks.map(([label, prompt]) => (
              <button key={label} type="button" disabled={isSubmitting} onClick={() => applyPick(prompt)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className="form-message error full-width">{error}</p> : null}
        {message ? <p className="form-message success full-width">{message}</p> : null}
      </form>

      <div className="sticker-canvas" onClick={() => setIsFestivalOpen(false)}>
        {isSubmitting ? (
          <div className="canvas-state">
            <div className="cat-bounce">🐱</div>
            <p>Ding Ding is generating...</p>
          </div>
        ) : null}

        {!isSubmitting && !record ? (
          <div className="canvas-state muted">
            <div>🐾</div>
            <p>Your sticker will appear here</p>
          </div>
        ) : null}

        {!isSubmitting && record ? (
          <div className="result-display">
            {generatedAssetUrl && record.format === "svg" ? (
              <img className="sticker-pop result-image" src={generatedAssetUrl} alt={record.description} />
            ) : (
              <div className="result-file-card">
                <span>{record.format.toUpperCase()}</span>
                <strong>{record.result?.localPath ?? "Generated file pending"}</strong>
              </div>
            )}

            <div className="result-meta">
              <p>{record.description}</p>
              <span>{record.result?.localPath ?? "No generated asset path yet"}</span>
            </div>

            <div className="result-actions">
              <button type="button" disabled={activeAction !== null} onClick={() => void handleDecision("reject")}>
                {activeAction === "reject" ? "Rejecting..." : "Reject"}
              </button>
              <button type="button" disabled={activeAction !== null} onClick={() => void handleDecision("accept")}>
                {activeAction === "accept" ? "Uploading..." : "Accept + upload"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="credit-line">Made with love by Tramplus · Powered by Gemini Nano Banana 2</p>
    </section>
  );
}
