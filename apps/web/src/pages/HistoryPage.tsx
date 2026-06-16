import { useEffect, useState } from "react";
import type { StickerRecord } from "@sticker-platform/shared";
import { listStickers } from "../lib/api";

export function HistoryPage() {
  const [records, setRecords] = useState<StickerRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    listStickers()
      .then((nextRecords) => {
        if (isMounted) {
          setRecords(nextRecords);
        }
      })
      .catch((caughtError) => {
        if (isMounted) {
          setError(caughtError instanceof Error ? caughtError.message : "Failed to load history");
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
  }, []);

  return (
    <section className="panel">
      <div className="section-heading">
        <p className="eyebrow">Local Cache</p>
        <h2>Generation History</h2>
        <p>Cached JSON records that have not been successfully uploaded to Notion yet.</p>
      </div>

      {isLoading ? <div className="empty-state">Loading cached records...</div> : null}
      {error ? <div className="empty-state error">{error}</div> : null}
      {!isLoading && !error && records.length === 0 ? <div className="empty-state">No cached sticker records yet.</div> : null}

      {records.length > 0 ? (
        <div className="record-list">
          {records.map((record) => (
            <article className="record-card" key={record.id}>
              <div>
                <p className="eyebrow">{record.status}</p>
                <h3>{record.description}</h3>
                <p>{record.description}</p>
              </div>
              <dl>
                <div>
                  <dt>Format</dt>
                  <dd>{record.format.toUpperCase()}</dd>
                </div>
                <div>
                  <dt>Theme</dt>
                  <dd>{record.theme}</dd>
                </div>
                <div>
                  <dt>JSON</dt>
                  <dd>{record.cachePath ?? "Not available"}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
