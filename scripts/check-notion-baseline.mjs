import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID ?? "";

const BASELINE_REFERENCE_NAMES = [
  "front.png", "left.png", "right.png", "back.png",
  "front_smile.png", "front_laugh.png", "front_holdflag.png", "front_clothes.png", "front_angry.png",
];

async function notionRequest(pathName, init = {}) {
  const response = await fetch(`https://api.notion.com/v1${pathName}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function main() {
  console.log("=== CONFIG ===");
  console.log(`NOTION_TOKEN: ${NOTION_TOKEN ? NOTION_TOKEN.slice(0, 12) + "..." : "(empty)"}`);
  console.log(`NOTION_DATABASE_ID: ${NOTION_DATABASE_ID || "(empty)"}`);

  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    console.log("\n❌ Notion is not configured. Add NOTION_TOKEN and NOTION_DATABASE_ID to .env");
    return;
  }

  // Step 1: Check what NOTION_DATABASE_ID points to
  console.log("\n=== STEP 1: Checking NOTION_DATABASE_ID ===");
  try {
    const db = await notionRequest(`/databases/${NOTION_DATABASE_ID}`);
    console.log(`✅ It's a database! Parent type: ${db.parent?.type}, page_id: ${db.parent?.page_id || "none"}`);
    await checkBaselineDatabase(NOTION_DATABASE_ID);
  } catch (err) {
    if (err.message.includes("404") || err.message.includes("not a database")) {
      console.log("⚠️  NOTION_DATABASE_ID is NOT a database — trying as a page...");
      try {
        const page = await notionRequest(`/pages/${NOTION_DATABASE_ID}`);
        console.log(`📄 It's a page. Looking for child databases...`);
        
        const blocks = await notionRequest(`/blocks/${NOTION_DATABASE_ID}/children`);
        const childDbs = (blocks.results ?? []).filter(b => b.type === "child_database");
        console.log(`  Found ${childDbs.length} child databases:`);
        for (const db of childDbs) {
          console.log(`  - "${db.child_database?.title}" (id: ${db.id})`);
        }
        
        const baselineDb = childDbs.find(b => b.child_database?.title === "baseline");
        if (baselineDb) {
          await checkBaselineDatabase(baselineDb.id);
        } else {
          console.log("\n❌ No 'baseline' child database found under this page!");
          console.log("   You need to create a 'baseline' database and upload the 9 reference images.");
          console.log("   Or run the Notion import to create it automatically.");
        }
      } catch (pageErr) {
        console.log(`❌ Also not a page: ${pageErr.message}`);
        console.log("   Check your NOTION_DATABASE_ID value in .env");
      }
    } else {
      console.log(`❌ Error: ${err.message}`);
    }
  }
}

async function checkBaselineDatabase(databaseId) {
  console.log(`\n=== STEP 2: Querying baseline database (${databaseId.slice(0, 10)}...) ===`);
  
  const response = await notionRequest(`/databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ page_size: 100 }),
  });
  
  const pages = response.results ?? [];
  console.log(`  Total pages in baseline: ${pages.length}`);
  
  const urlByName = new Map();
  for (const page of pages) {
    const title = page.properties?.Name?.title?.[0]?.plain_text;
    const fileUrl = page.properties?.File?.files?.[0]?.file?.url 
                 ?? page.properties?.File?.files?.[0]?.external?.url;
    if (title) {
      urlByName.set(title, fileUrl || null);
    }
  }
  
  console.log("\n  Expected baseline images:");
  let found = 0;
  let missing = 0;
  for (const name of BASELINE_REFERENCE_NAMES) {
    const hasUrl = urlByName.has(name);
    const url = urlByName.get(name);
    const status = hasUrl && url ? "✅" : "❌";
    if (status === "✅") found++; else missing++;
    const detail = !hasUrl ? "NOT FOUND" : !url ? "no file URL" : url.slice(0, 70) + "...";
    console.log(`  ${status} ${name} — ${detail}`);
  }
  
  console.log(`\n  Summary: ${found}/9 mandatory images found, ${missing}/9 missing`);
  
  if (missing > 0) {
    console.log("\n❌ ISSUE: Your Notion baseline database is missing reference images.");
    console.log("   Without these, the model cannot see what Ding Ding Cat looks like.");
    console.log("   Expected files: front.png, left.png, right.png, back.png, front_smile.png,");
    console.log("   front_laugh.png, front_holdflag.png, front_clothes.png, front_angry.png");
  } else {
    console.log("\n✅ All 9 mandatory baseline images are in Notion!");
    
    console.log("\n=== STEP 3: Testing if file URLs are accessible (HEAD requests) ===");
    let accessible = 0;
    let inaccessible = 0;
    for (const name of BASELINE_REFERENCE_NAMES) {
      const url = urlByName.get(name);
      if (!url) continue;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) {
          accessible++;
          console.log(`  ✅ ${name} — OK (${resp.headers.get("content-type") || "?"}, ${resp.headers.get("content-length") || "?"}b)`);
        } else {
          inaccessible++;
          console.log(`  ❌ ${name} — HTTP ${resp.status}, URL may have expired`);
        }
      } catch (e) {
        inaccessible++;
        console.log(`  ❌ ${name} — ${e.message?.slice(0, 80)}`);
      }
    }
    console.log(`\n  URL accessibility: ${accessible} accessible, ${inaccessible} inaccessible`);
    if (inaccessible > 0) {
      console.log("  ⚠️  Some Notion file URLs have expired. Re-upload the files to refresh them.");
    }
  }
  
  const supplemental = pages.filter(p => {
    const name = p.properties?.Name?.title?.[0]?.plain_text;
    return name && !BASELINE_REFERENCE_NAMES.includes(name);
  });
  if (supplemental.length > 0) {
    console.log(`\n  Supplemental images (${supplemental.length} total):`);
    for (const p of supplemental) {
      console.log(`  - ${p.properties?.Name?.title?.[0]?.plain_text}`);
    }
  }
  
  console.log("\n=== DIAGNOSIS COMPLETE ===");
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
