import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { StickerRecord } from "@sticker-platform/shared";
import { acceptSticker, generateSticker, getSticker, rejectSticker } from "../lib/api";

export function StickerDetailPage() {
  const { id } = useParams();
  const [record, setRecord] = useState<StickerRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<"generate" | "accept" | "reject" | null>(null);

  useEffect(() => {
    if (!id) {
      setError("Missing sticker id");
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    getSticker(id)
      .then((nextRecord) => {
        if (isMounted) {
          setRecord(nextRecord);
        }
      })
      .catch((caughtError) => {
        if (isMounted) {
          setError(caughtError instanceof Error ? caughtError.message : "Failed to load sticker");
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [id]);

  async function runAction(action: "generate" | "accept" | "reject") {
    if (!record) {
      return;
    }

    setError(null);
    setMessage(null);
    setActiveAction(action);

    try {
      if (action === "generate") {
        setRecord(await generateSticker(record.id));
      }

      if (action === "reject") {
        setRecord(await rejectSticker(record.id));
      }

      if (action === "accept") {
        const result = await acceptSticker(record.id);
        setRecord(null);
        setMessage(`Uploaded to Notion placeholder ${result.notionPageId}. Local JSON cache removed.`);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : `Failed to ${action} sticker`);
    } finally {
      setActiveAction(null);
    }
  }

  if (isLoading) {
    return <section className="panel">Loading sticker...</section>;
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <p className="eyebrow">Review</p>
        <h2>Sticker Detail</h2>
        <p>Review the local JSON record, run placeholder generation, then upload and clear cache.</p>
      </div>

      {error ? <div className="empty-state error">{error}</div> : null}
      {message ? <div className="empty-state success">{message}</div> : null}

      {record ? (
        <div className="detail-grid">
          <div className="preview-box">
            {record.result?.localPath ? record.result.localPath : "Generated sticker preview will appear here."}
          </div>

          <aside className="record-summary">
            <p className="eyebrow">{record.status}</p>
            <h3>{record.stickerContent}</h3>
            <dl>
              <div>
                <dt>ID</dt>
                <dd>{record.id}</dd>
              </div>
              <div>
                <dt>JSON Cache Path</dt>
                <dd>{record.cachePath ?? "Not available"}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{record.type}</dd>
              </div>
              <div>
                <dt>Generated Asset Path</dt>
                <dd>{record.result?.localPath ?? "Not generated yet"}</dd>
              </div>
              <div>
                <dt>Theme</dt>
                <dd>{record.theme}</dd>
              </div>
              <div>
                <dt>Category</dt>
                <dd>{record.category}</dd>
              </div>
              <div>
                <dt>Description</dt>
                <dd>{record.description}</dd>
              </div>
            </dl>

            <div className="action-row">
              <button type="button" disabled={activeAction !== null} onClick={() => void runAction("generate")}>
                {activeAction === "generate" ? "Generating..." : "Generate Placeholder"}
              </button>
              <button type="button" disabled={activeAction !== null} onClick={() => void runAction("reject")}>
                {activeAction === "reject" ? "Rejecting..." : "Reject"}
              </button>
              <button type="button" disabled={activeAction !== null} onClick={() => void runAction("accept")}>
                {activeAction === "accept" ? "Uploading..." : "Accept + Upload"}
              </button>
            </div>
          </aside>

          <section className="json-panel full-width">
            <div className="section-heading compact">
              <p className="eyebrow">Raw JSON</p>
              <h3>Cached Record</h3>
            </div>
            <pre>{JSON.stringify(record, null, 2)}</pre>
          </section>
        </div>
      ) : null}
    </section>
  );
}
