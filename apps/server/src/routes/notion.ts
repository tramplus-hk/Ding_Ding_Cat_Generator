import { Router } from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveStaleDataFolderRows, type DataFolderFile, uploadDataFolderFile } from "../services/notion.js";

export const notionRouter = Router();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataRoot = path.join(projectRoot, "data");
const dataGroups = ["baseline", "generated", "history"] as const;

async function listDataFolderFiles(): Promise<DataFolderFile[]> {
  const files: DataFolderFile[] = [];

  for (const group of dataGroups) {
    const groupRoot = path.join(dataRoot, group);
    const categories = await readdir(groupRoot, { withFileTypes: true }).catch(() => []);

    for (const categoryEntry of categories) {
      if (!categoryEntry.isDirectory()) {
        continue;
      }

      const category = categoryEntry.name;
      const categoryRoot = path.join(groupRoot, category);
      const categoryFiles = await listFiles(categoryRoot);

      for (const absolutePath of categoryFiles) {
        const relativePath = path.relative(projectRoot, absolutePath);
        const content = path.relative(categoryRoot, absolutePath);

        files.push({
          group,
          category,
          content,
          relativePath,
          absolutePath,
        });
      }
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.name === ".DS_Store" || entry.name === ".gitkeep") {
        return [];
      }

      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }

      return entry.isFile() ? [entryPath] : [];
    }),
  );

  return nested.flat();
}

notionRouter.post("/import", async (_req, res, next) => {
  try {
    const files = await listDataFolderFiles();
    const imported = [];

    for (const file of files) {
      imported.push({ path: file.relativePath, notionPageId: await uploadDataFolderFile(file) });
    }

    const archived = Object.fromEntries(
      await Promise.all(
        dataGroups.map(async (group) => [
          group,
          await archiveStaleDataFolderRows(
            group,
            new Set(files.filter((file) => file.group === group).map((file) => file.relativePath)),
          ),
        ]),
      ),
    );

    res.json({ imported: imported.length, archived, records: imported });
  } catch (error) {
    next(error);
  }
});
