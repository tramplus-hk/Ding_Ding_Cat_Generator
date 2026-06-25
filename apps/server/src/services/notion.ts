import type { StickerRecord } from "@sticker-platform/shared";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { readRuntimeBlob } from "./runtimeBlob.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const notionVersion = "2022-06-28";
const notionFileUploadVersion = "2026-03-11";
const dataGroupTitles = {
  baseline: "baseline",
  reference: "reference",
  generated: "generated",
  history: "history",
} as const;
const rejectedDatabaseTitle = "rejected";
const dataFolderDatabaseProperties = {
  Name: { title: {} },
  Category: { rich_text: {} },
  Content: { rich_text: {} },
  "File Type": { select: {} },
  Extension: { rich_text: {} },
  "Relative Path": { rich_text: {} },
  File: { files: {} },
  "Size Bytes": { number: {} },
  "Updated At": { date: {} },
};
const rejectedDatabaseProperties = {
  Name: { title: {} },
  "Record ID": { rich_text: {} },
  Theme: { rich_text: {} },
  Motion: { rich_text: {} },
  Prompt: { rich_text: {} },
  "Reject Reason": { rich_text: {} },
  "Selected Candidate": { rich_text: {} },
  "Candidate Count": { number: {} },
  Model: { select: {} },
  "Created At": { date: {} },
  "Updated At": { date: {} },
};

export type DataFolderGroup = "baseline" | "reference" | "generated" | "history";

export type DataFolderFile = {
  group: DataFolderGroup;
  category: string;
  content: string;
  relativePath: string;
  absolutePath: string;
  data?: Buffer;
  textContent?: string;
  sizeBytes?: number;
  updatedAt?: string;
};

type NotionPageResult = {
  id: string;
  properties?: Record<string, unknown>;
};

type NotionQueryResponse = {
  results?: NotionPageResult[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionDatabaseResponse = {
  id: string;
  object?: string;
  parent?: { type?: string; page_id?: string };
};

type NotionBlockResult = {
  id: string;
  type?: string;
  child_database?: { title?: string };
  code?: { rich_text?: Array<{ plain_text?: string }> };
};

type NotionBlockChildrenResponse = {
  results?: NotionBlockResult[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionFileUploadResponse = {
  id: string;
  upload_url?: string;
  status?: string;
};

type NotionFileProperty = {
  files?: Array<{
    type?: string;
    file?: { url?: string };
    external?: { url?: string };
  }>;
};

const resolvedDataDatabaseIds = new Map<DataFolderGroup, string>();
let resolvedRejectedDatabaseId: string | undefined;

function richText(content?: string) {
  const text = content ?? "";

  return { rich_text: text ? [{ text: { content: text.slice(0, 2000) } }] : [] };
}

function title(content: string) {
  return { title: [{ text: { content: content.slice(0, 2000) } }] };
}

function select(name?: string) {
  return name ? { select: { name } } : { select: null };
}

function date(start?: string) {
  return start ? { date: { start } } : { date: null };
}

function number(value?: number) {
  return typeof value === "number" ? { number: value } : { number: null };
}

function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  if (extension === ".gif") {
    return "image/gif";
  }

  if (extension === ".json") {
    return "application/json";
  }

  return "application/octet-stream";
}

function isImageFile(filePath: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(filePath);
}

async function notionRequest<T>(pathName: string, init: RequestInit = {}, version = notionVersion): Promise<T> {
  if (!config.notionToken) {
    throw new Error("NOTION_TOKEN is not configured");
  }

  const response = await fetch(`https://api.notion.com/v1${pathName}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      "Notion-Version": version,
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion request failed with ${response.status}: ${body.slice(0, 500)}`);
  }

  return (await response.json()) as T;
}

async function tryGetDatabase(databaseId: string): Promise<NotionDatabaseResponse | undefined> {
  try {
    return await notionRequest<NotionDatabaseResponse>(`/databases/${databaseId}`);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Notion request failed with 404") || error.message.includes("is a page, not a database"))
    ) {
      return undefined;
    }

    throw error;
  }
}

async function getNotionParentPageId(): Promise<string | undefined> {
  if (!config.notionToken || !config.notionDatabaseId) {
    return undefined;
  }

  const database = await tryGetDatabase(config.notionDatabaseId);

  if (database?.parent?.type === "page_id" && database.parent.page_id) {
    return database.parent.page_id;
  }

  return config.notionDatabaseId;
}

async function findChildDatabase(parentPageId: string, titleText: string): Promise<string | undefined> {
  let cursor: string | undefined;

  while (true) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const response = await notionRequest<NotionBlockChildrenResponse>(`/blocks/${parentPageId}/children${query}`);
    const childDatabase = response.results?.find(
      (block) => block.type === "child_database" && block.child_database?.title === titleText,
    );

    if (childDatabase) {
      return childDatabase.id;
    }

    if (!response.has_more || !response.next_cursor) {
      return undefined;
    }

    cursor = response.next_cursor;
  }
}

async function createDatabase(parentPageId: string, titleText: string): Promise<string> {
  const properties = titleText === rejectedDatabaseTitle ? rejectedDatabaseProperties : dataFolderDatabaseProperties;
  const database = await notionRequest<NotionDatabaseResponse>("/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: titleText } }],
      properties,
    }),
  });

  console.log(`Created Notion ${titleText} database: ${database.id}`);

  return database.id;
}

async function ensureDatabaseSchema(databaseId: string): Promise<void> {
  await notionRequest<NotionDatabaseResponse>(`/databases/${databaseId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: dataFolderDatabaseProperties }),
  });
}

async function ensureRejectedDatabaseSchema(databaseId: string): Promise<void> {
  await notionRequest<NotionDatabaseResponse>(`/databases/${databaseId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: rejectedDatabaseProperties }),
  });
}

export async function getDataGroupDatabaseId(group: DataFolderGroup): Promise<string | undefined> {
  const cached = resolvedDataDatabaseIds.get(group);

  if (cached) {
    return cached;
  }

  const parentPageId = await getNotionParentPageId();

  if (!parentPageId) {
    return undefined;
  }

  const titleText = dataGroupTitles[group];
  const existingDatabaseId = await findChildDatabase(parentPageId, titleText);
  const databaseId = existingDatabaseId ?? (await createDatabase(parentPageId, titleText));

  await ensureDatabaseSchema(databaseId);
  resolvedDataDatabaseIds.set(group, databaseId);

  return databaseId;
}

async function getRejectedDatabaseId(): Promise<string | undefined> {
  if (resolvedRejectedDatabaseId) {
    return resolvedRejectedDatabaseId;
  }

  const parentPageId = await getNotionParentPageId();

  if (!parentPageId) {
    return undefined;
  }

  const existingDatabaseId = await findChildDatabase(parentPageId, rejectedDatabaseTitle);
  const databaseId = existingDatabaseId ?? (await createDatabase(parentPageId, rejectedDatabaseTitle));

  await ensureRejectedDatabaseSchema(databaseId);
  resolvedRejectedDatabaseId = databaseId;

  return databaseId;
}

async function buildDataFileProperties(file: DataFolderFile, uploadedFileId?: string) {
  const stats = file.data ? undefined : await stat(file.absolutePath);
  const extension = path.extname(file.relativePath).replace(/^\./, "");
  const fileType = extension === "json" ? "json" : isImageFile(file.relativePath) ? "image" : "file";

  return {
    Name: title(path.basename(file.content)),
    Category: richText(file.category),
    Content: richText(file.content),
    "File Type": select(fileType),
    Extension: richText(extension),
    "Relative Path": richText(file.relativePath),
    File: uploadedFileId
      ? { files: [{ name: path.basename(file.relativePath), type: "file_upload", file_upload: { id: uploadedFileId } }] }
      : { files: [] },
    "Size Bytes": number(file.sizeBytes ?? stats?.size),
    "Updated At": date(file.updatedAt ?? stats?.mtime.toISOString()),
  };
}

async function findDataFilePage(databaseId: string, relativePath: string): Promise<string | undefined> {
  const response = await notionRequest<NotionQueryResponse>(`/databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        property: "Relative Path",
        rich_text: { equals: relativePath },
      },
      page_size: 1,
    }),
  });

  return response.results?.[0]?.id;
}

function getRichTextProperty(page: NotionPageResult, propertyName: string): string | undefined {
  const property = page.properties?.[propertyName] as { rich_text?: Array<{ plain_text?: string }> } | undefined;

  return property?.rich_text?.[0]?.plain_text;
}

function getTitleProperty(page: NotionPageResult, propertyName: string): string | undefined {
  const property = page.properties?.[propertyName] as { title?: Array<{ plain_text?: string }> } | undefined;

  return property?.title?.[0]?.plain_text;
}

function getFilePropertyUrl(page: NotionPageResult, propertyName: string): string | undefined {
  const property = page.properties?.[propertyName] as NotionFileProperty | undefined;
  const file = property?.files?.[0];

  return file?.file?.url ?? file?.external?.url;
}

async function listDatabasePages(databaseId: string): Promise<NotionPageResult[]> {
  const pages: NotionPageResult[] = [];
  let cursor: string | undefined;

  while (true) {
    const response = await notionRequest<NotionQueryResponse>(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
    });

    pages.push(...(response.results ?? []));

    if (!response.has_more || !response.next_cursor) {
      return pages;
    }

    cursor = response.next_cursor;
  }
}

async function archivePageChildren(pageId: string): Promise<void> {
  let cursor: string | undefined;

  while (true) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const response = await notionRequest<NotionBlockChildrenResponse>(`/blocks/${pageId}/children${query}`);

    for (const block of response.results ?? []) {
      await notionRequest(`/blocks/${block.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
    }

    if (!response.has_more || !response.next_cursor) {
      return;
    }

    cursor = response.next_cursor;
  }
}

async function uploadFileToNotion(file: DataFolderFile): Promise<string> {
  const createResponse = await notionRequest<NotionFileUploadResponse>("/file_uploads", {
    method: "POST",
    body: JSON.stringify({
      mode: "single_part",
      filename: path.basename(file.absolutePath),
      content_type: getMimeType(file.absolutePath),
    }),
  }, notionFileUploadVersion);
  const formData = new FormData();
  const raw = file.data ?? (await readFile(file.absolutePath));
  const blobPart = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;

  formData.append("file", new Blob([blobPart], { type: getMimeType(file.absolutePath) }), path.basename(file.absolutePath));

  await notionRequest<NotionFileUploadResponse>(`/file_uploads/${createResponse.id}/send`, {
    method: "POST",
    body: formData,
  }, notionFileUploadVersion);

  return createResponse.id;
}

function getPageChildren(file: DataFolderFile, uploadedFileId?: string) {
  if (isImageFile(file.relativePath) && uploadedFileId) {
    return [
      {
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: uploadedFileId },
          caption: [{ type: "text", text: { content: file.relativePath } }],
        },
      },
    ];
  }

  if (path.extname(file.relativePath).toLowerCase() === ".json") {
    return [
      {
        object: "block",
        type: "code",
        code: {
          language: "json",
          rich_text: [{ type: "text", text: { content: "" } }],
        },
      },
    ];
  }

  if (uploadedFileId) {
    return [
      {
        object: "block",
        type: "file",
        file: {
          type: "file_upload",
          file_upload: { id: uploadedFileId },
          caption: [{ type: "text", text: { content: file.relativePath } }],
        },
      },
    ];
  }

  return [];
}

function getImageBlock(file: DataFolderFile, uploadedFileId: string) {
  return {
    object: "block",
    type: "image",
    image: {
      type: "file_upload",
      file_upload: { id: uploadedFileId },
      caption: [{ type: "text", text: { content: file.relativePath } }],
    },
  };
}

async function appendPageContent(pageId: string, file: DataFolderFile, uploadedFileId?: string): Promise<void> {
  const children = getPageChildren(file, uploadedFileId) as Array<Record<string, any>>;

  if (path.extname(file.relativePath).toLowerCase() === ".json") {
    const rawJson = file.textContent ?? (await readFile(file.absolutePath, "utf8"));
    children[0].code.rich_text = rawJson.match(/[\s\S]{1,1900}/g)?.map((content) => ({ type: "text", text: { content } })) ?? [
      { type: "text", text: { content: "" } },
    ];
  }

  if (children.length === 0) {
    return;
  }

  await notionRequest(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: JSON.stringify({ children }),
  });
}

export async function archiveStaleDataFolderRows(group: DataFolderGroup, validRelativePaths: Set<string>): Promise<number> {
  const databaseId = await getDataGroupDatabaseId(group);

  if (!databaseId) {
    return 0;
  }

  const pages = await listDatabasePages(databaseId);
  let archived = 0;

  for (const page of pages) {
    const relativePath = getRichTextProperty(page, "Relative Path");

    if (relativePath && validRelativePaths.has(relativePath)) {
      continue;
    }

    await notionRequest<NotionPageResult>(`/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
    archived += 1;
  }

  return archived;
}

export async function uploadDataFolderFile(file: DataFolderFile): Promise<string> {
  const databaseId = await getDataGroupDatabaseId(file.group);

  if (!databaseId) {
    return "notion-not-configured";
  }

  const uploadedFileId = path.extname(file.relativePath).toLowerCase() === ".json" ? undefined : await uploadFileToNotion(file);
  const existingPageId = await findDataFilePage(databaseId, file.relativePath);
  const properties = await buildDataFileProperties(file, uploadedFileId);

  if (existingPageId) {
    const page = await notionRequest<NotionPageResult>(`/pages/${existingPageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });

    await archivePageChildren(page.id);
    await appendPageContent(page.id, file, uploadedFileId);
    return page.id;
  }

  const page = await notionRequest<NotionPageResult>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children: getPageChildren(file, uploadedFileId),
    }),
  });

  if (path.extname(file.relativePath).toLowerCase() === ".json") {
    await archivePageChildren(page.id);
    await appendPageContent(page.id, file, uploadedFileId);
  }

  return page.id;
}

export async function listDataFolderRows(group: DataFolderGroup): Promise<NotionPageResult[]> {
  const databaseId = await getDataGroupDatabaseId(group);

  if (!databaseId) {
    return [];
  }

  return listDatabasePages(databaseId);
}

export async function listDataFolderFileUrls(group: DataFolderGroup, category?: string): Promise<string[]> {
  const pages = await listDataFolderRows(group);

  return pages
    .filter((page) => !category || getRichTextProperty(page, "Category") === category)
    .map((page) => getFilePropertyUrl(page, "File"))
    .filter((url): url is string => Boolean(url));
}

async function getPageCodeContent(pageId: string): Promise<string | undefined> {
  let cursor: string | undefined;
  let content = "";

  while (true) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const response = await notionRequest<NotionBlockChildrenResponse>(`/blocks/${pageId}/children${query}`);

    for (const block of response.results ?? []) {
      if (block.type === "code") {
        content += block.code?.rich_text?.map((part) => part.plain_text ?? "").join("") ?? "";
      }
    }

    if (!response.has_more || !response.next_cursor) {
      return content || undefined;
    }

    cursor = response.next_cursor;
  }
}

export async function listNotionHistoryRecords(): Promise<StickerRecord[]> {
  const pages = await listDataFolderRows("history");
  const records = await Promise.all(
    pages.map(async (page) => {
      const json = await getPageCodeContent(page.id);

      if (!json) {
        return undefined;
      }

      return JSON.parse(json) as StickerRecord;
    }),
  );

  return records.filter((record): record is StickerRecord => Boolean(record));
}

export async function getAvailableNotionContentName(
  group: DataFolderGroup,
  category: string,
  baseName: string,
  extension: string,
): Promise<string> {
  const pages = await listDataFolderRows(group);
  const usedNames = new Set(
    pages
      .filter((page) => getRichTextProperty(page, "Category") === category)
      .map((page) => path.parse(getTitleProperty(page, "Name") ?? "").name),
  );
  let index = 0;

  while (true) {
    const candidateName = index === 0 ? baseName : `${baseName}_${index}`;

    if (!usedNames.has(candidateName)) {
      return `${candidateName}${extension}`;
    }

    index += 1;
  }
}

async function findRejectedPage(databaseId: string, recordId: string): Promise<string | undefined> {
  const response = await notionRequest<NotionQueryResponse>(`/databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        property: "Record ID",
        rich_text: { equals: recordId },
      },
      page_size: 1,
    }),
  });

  return response.results?.[0]?.id;
}

function buildRejectedProperties(record: StickerRecord, reason?: string) {
  return {
    Name: title(`${record.theme}/${record.description}`),
    "Record ID": richText(record.id),
    Theme: richText(record.theme),
    Motion: richText(record.description),
    Prompt: richText(`${record.theme}: ${record.description}`),
    "Reject Reason": richText(reason),
    "Selected Candidate": richText(record.result?.selectedPath),
    "Candidate Count": number(record.result?.candidates?.length ?? 0),
    Model: select(record.result?.provider ?? "gpt-image-2"),
    "Created At": date(record.createdAt),
    "Updated At": date(record.updatedAt),
  };
}

export async function uploadRejectedStickerRun(record: StickerRecord, reason?: string): Promise<string> {
  const databaseId = await getRejectedDatabaseId();

  if (!databaseId) {
    return "notion-not-configured";
  }

  const candidateFiles = await Promise.all(
    (record.result?.candidates ?? []).map(async (candidatePath, index) => {
      const candidateAbsolutePath = candidatePath.startsWith(".runtime/generated/")
        ? path.join(config.runtimeGeneratedRoot, path.relative(".runtime/generated", candidatePath))
        : path.join(projectRoot, candidatePath);
      try {
        const candidateUrl = record.result?.candidateUrls?.[candidatePath];
        const data = candidateUrl
          ? await readRuntimeBlob(candidateUrl)
          : await readFile(candidateAbsolutePath);
        if (!data) {
          return null;
        }
        const file: DataFolderFile = {
          group: "generated",
          category: record.theme,
          content: `candidate_${String(index + 1).padStart(2, "0")}${path.extname(candidatePath)}`,
          relativePath: candidatePath,
          absolutePath: candidateAbsolutePath,
          data,
          sizeBytes: data.byteLength,
          updatedAt: new Date().toISOString(),
        };
        return { file, uploadedFileId: await uploadFileToNotion(file) };
      } catch {
        return null;
      }
    }),
  );
  const uploadedFiles = candidateFiles.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const properties = buildRejectedProperties(record, reason);
  const existingPageId = await findRejectedPage(databaseId, record.id);

  if (existingPageId) {
    const page = await notionRequest<NotionPageResult>(`/pages/${existingPageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });

    await archivePageChildren(page.id);
    if (uploadedFiles.length > 0) {
      await notionRequest(`/blocks/${page.id}/children`, {
        method: "PATCH",
        body: JSON.stringify({ children: uploadedFiles.map(({ file, uploadedFileId }) => getImageBlock(file, uploadedFileId)) }),
      });
    }

    return page.id;
  }

  const page = await notionRequest<NotionPageResult>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children: uploadedFiles.map(({ file, uploadedFileId }) => getImageBlock(file, uploadedFileId)),
    }),
  });

  return page.id;
}

function dataFileFromRelativePath(relativePath: string): DataFolderFile | undefined {
  const [dataRoot, group, category, ...rest] = relativePath.split(path.sep);

  if (dataRoot !== "data" || !category || !["baseline", "reference", "generated", "history"].includes(group)) {
    return undefined;
  }

  return {
    group: group as DataFolderGroup,
    category,
    content: rest.length > 0 ? rest.join("/") : path.basename(relativePath),
    relativePath,
    absolutePath: path.join(projectRoot, relativePath),
  };
}

export async function uploadFinalStickerJson(record: StickerRecord): Promise<string> {
  const pageIds: string[] = [];
  const localPathFile = record.result?.localPath ? dataFileFromRelativePath(record.result.localPath) : undefined;
  const cachePathFile = record.cachePath ? dataFileFromRelativePath(record.cachePath) : undefined;

  if (localPathFile) {
    pageIds.push(await uploadDataFolderFile(localPathFile));
  }

  if (cachePathFile) {
    pageIds.push(await uploadDataFolderFile(cachePathFile));
  }

  return pageIds[0] ?? "notion-not-configured";
}

export async function uploadAcceptedStickerRecord(record: StickerRecord, sourceAbsolutePath: string): Promise<string> {
  if (!record.result?.localPath || !record.cachePath) {
    throw new Error("Accepted sticker record must include localPath and cachePath before Notion upload");
  }

  const imageBuffer = await readFile(sourceAbsolutePath);
  const imagePageId = await uploadDataFolderFile({
    group: "generated",
    category: record.theme,
    content: path.basename(record.result.localPath),
    relativePath: record.result.localPath,
    absolutePath: sourceAbsolutePath,
    data: imageBuffer,
    sizeBytes: imageBuffer.byteLength,
    updatedAt: record.updatedAt,
  });
  const recordWithNotionPageId = {
    ...record,
    result: record.result ? { ...record.result, notionPageId: imagePageId } : record.result,
  };
  const jsonContent = `${JSON.stringify(recordWithNotionPageId, null, 2)}\n`;

  await uploadDataFolderFile({
    group: "history",
    category: record.theme,
    content: path.basename(record.cachePath),
    relativePath: record.cachePath,
    absolutePath: record.cachePath,
    data: Buffer.from(jsonContent, "utf8"),
    textContent: jsonContent,
    sizeBytes: Buffer.byteLength(jsonContent),
    updatedAt: record.updatedAt,
  });

  return imagePageId;
}
