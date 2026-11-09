// Shared by the buildless browser and offline candidate validator. No private inputs.
export const HISTORY_SHA256 = "b6f66a02d9b3c673cba480d1918442779f931ccb70b2c0ff7deb5ea49e498713";
export const HISTORY_URL = "https://f3ironplains.github.io/operation-independence-public/operation-independence-2026.json";
const hashPattern = /^[a-f0-9]{64}$/;
const fail = message => { throw new Error(message); };
function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      allowed.some(key => !Object.hasOwn(value, key))) fail("Invalid public fields");
}
function date(value, year) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value.startsWith(`${year}-`) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}
function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function futureResultsPath(year, sha256) {
  if (!Number.isInteger(year) || year < 2027 || year > 9999 || !hashPattern.test(sha256)) fail("Invalid future result path");
  return `seasons/${year}/results/${sha256}.json`;
}
export function validateManifest(input) {
  keys(input, ["schemaVersion", "entrySeasonId", "defaultSeasonId", "seasons"]);
  if (input.schemaVersion !== 1 || !Array.isArray(input.seasons) || !input.seasons.length) fail("Invalid season manifest");
  const ids = new Set();
  for (const season of input.seasons) {
    keys(season, ["id", "year", "name", "startsOn", "endsOn", "status", "results"]);
    if (!Number.isInteger(season.year) || season.year < 2026 || season.year > 9999 ||
        season.id !== String(season.year) || ids.has(season.id) ||
        typeof season.name !== "string" || !season.name.trim() || season.name.length > 100 ||
        !["upcoming", "active", "completed", "archived"].includes(season.status)) fail("Invalid season");
    ids.add(season.id);
    const pendingDates = season.startsOn === null && season.endsOn === null;
    if (!(season.status === "upcoming" && pendingDates) &&
        (!date(season.startsOn, season.year) || !date(season.endsOn, season.year) || season.startsOn > season.endsOn)) fail("Invalid season dates");
    const result = season.results;
    if (season.status === "upcoming" && result !== null) fail("Upcoming season cannot have results");
    if (["completed", "archived"].includes(season.status) && !result) fail("Historical season needs final results");
    if (result !== null) {
      keys(result, ["path", "sha256", "designation", "finalizedAt"]);
      if (!hashPattern.test(result.sha256) || !["final", "provisional"].includes(result.designation)) fail("Invalid result metadata");
      if (result.designation === "final" && season.year > 2026 ? !timestamp(result.finalizedAt) : result.finalizedAt !== null) fail("Invalid finalization");
      if ((["completed", "archived"].includes(season.status)) !== (result.designation === "final")) fail("Season lifecycle and result designation disagree");
      if (season.year > 2026 && result.path !== futureResultsPath(season.year, result.sha256)) fail("Unsafe result location");
    }
    if (season.year === 2026 && (season.name !== "Operation Independence" ||
        season.status !== "archived" || season.startsOn !== "2026-07-01" || season.endsOn !== "2026-07-31" ||
        result?.path !== "operation-independence-2026.json" || result.sha256 !== HISTORY_SHA256 ||
        result.finalizedAt !== null)) fail("Protected 2026 archive changed");
  }
  if (!ids.has("2026") || input.defaultSeasonId !== "2026" || !ids.has(input.entrySeasonId)) fail("Missing season or changed legacy default");
  return input;
}
export function selectSeason(manifest, search = "") {
  validateManifest(manifest);
  const params = new URLSearchParams(search);
  const selections = params.getAll("season");
  if (selections.length > 1) fail("Select one season");
  const id = selections.length ? selections[0] : manifest.defaultSeasonId;
  return manifest.seasons.find(season => season.id === id) ?? fail("Season unavailable. Choose a listed season.");
}
// Explicit allowlist: raw scorer/D1 records must never be serialized as public results.
// Approved public names are still an operator review responsibility.
export function validateFutureResults(input, season) {
  keys(input, ["seasonId", "year", "generatedAt", "standings"]);
  if (season.year < 2027 || input.seasonId !== season.id || input.year !== season.year ||
      !timestamp(input.generatedAt) || !Array.isArray(input.standings)) fail("Invalid future results");
  if (season.results?.designation === "final" && input.generatedAt > season.results.finalizedAt) fail("Finalization predates result generation");
  for (const row of input.standings) {
    keys(row, ["publicName", "totalPoints"]);
    if (typeof row.publicName !== "string" || !row.publicName.trim() || row.publicName.length > 80 ||
        !Number.isFinite(row.totalPoints) || row.totalPoints < 0) fail("Invalid public standing");
  }
  return input;
}
export async function verifyResultsBytes(bytes, season) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  if (hash !== season.results?.sha256) fail("Results integrity check failed. No standings displayed.");
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (season.year === 2026) {
    if (data.challenge?.year !== 2026 || data.leaderboard?.length !== 73 || data.teams?.length !== 8 ||
        data.generatedAt !== "2026-08-02T13:01:40.671Z") fail("Invalid historical metadata");
  } else validateFutureResults(data, season);
  return data;
}
export async function loadSeasonResults(season, fetcher = fetch) {
  if (!season.results) return null;
  // Always read canonical public history, never the private intermediate JSON.
  const url = season.year === 2026 ? HISTORY_URL : `./${season.results.path}`;
  const response = await fetcher(url, { cache: "no-store", redirect: "error" });
  if (!response.ok) fail("Results unavailable. Please try again later.");
  return verifyResultsBytes(await response.arrayBuffer(), season);
}
export function assertFinalizedSeasonsUnchanged(previous, candidate) {
  validateManifest(previous);
  validateManifest(candidate);
  for (const season of previous.seasons.filter(item => item.results?.designation === "final")) {
    const next = candidate.seasons.find(item => item.id === season.id);
    // Archiving a completed season changes only its lifecycle label.
    if (!next || stableJson({ ...next, status: season.status }) !== stableJson(season) ||
        (next.status !== season.status && !(season.status === "completed" && next.status === "archived"))) fail(`Finalized season ${season.id} is immutable`);
  }
}
function stableJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
