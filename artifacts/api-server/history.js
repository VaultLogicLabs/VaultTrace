import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

export const MAX_HISTORY = 200;

let writeQueue = Promise.resolve();

async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(HISTORY_FILE);
  } catch {
    await fs.writeFile(HISTORY_FILE, "[]", "utf8");
  }
}

export async function loadHistory() {
  await ensureFile();
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAtomic(history) {
  writeQueue = writeQueue.then(async () => {
    await ensureFile();
    const tmp = `${HISTORY_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(history), "utf8");
    await fs.rename(tmp, HISTORY_FILE);
  });
  return writeQueue;
}

function isReport(r) {
  return (
    r &&
    typeof r === "object" &&
    typeof r.mint === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint) &&
    typeof r.timestamp === "string"
  );
}

function sortNewestFirst(list) {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a.timestamp) || 0;
    const tb = Date.parse(b.timestamp) || 0;
    return tb - ta;
  });
}

export async function addReport(report) {
  if (!isReport(report)) {
    const err = new Error("Invalid report payload");
    err.statusCode = 400;
    throw err;
  }
  const current = await loadHistory();
  const deduped = current.filter((r) => r.mint !== report.mint);
  const next = sortNewestFirst([report, ...deduped]).slice(0, MAX_HISTORY);
  await writeAtomic(next);
  return next;
}

export async function clearHistory() {
  await writeAtomic([]);
  return [];
}

export async function mergeReports(reports) {
  if (!Array.isArray(reports)) {
    const err = new Error("Body must be an array of reports");
    err.statusCode = 400;
    throw err;
  }
  const valid = reports.filter(isReport);
  const current = await loadHistory();

  const byMint = new Map();
  for (const r of [...current, ...valid]) {
    const existing = byMint.get(r.mint);
    if (!existing) {
      byMint.set(r.mint, r);
      continue;
    }
    const tExisting = Date.parse(existing.timestamp) || 0;
    const tNew = Date.parse(r.timestamp) || 0;
    if (tNew > tExisting) byMint.set(r.mint, r);
  }

  const merged = sortNewestFirst([...byMint.values()]).slice(0, MAX_HISTORY);
  await writeAtomic(merged);
  return merged;
}
