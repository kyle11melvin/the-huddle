// Shared display constants and tiny helpers.
//
// Extracted from App.jsx (review finding: code health, step 2). SLOT_COLOR was
// also duplicated verbatim in LeagueBrowser.jsx — one definition now.
export const SLOT_COLOR = {
  QB: "#ff5c6c",
  RB: "#2ed584",
  WR: "#5b8cff",
  TE: "#a78bfa",
  FLEX: "#8b93a1",
  "D/ST": "#8b93a1",
  K: "#8b93a1",
  BN: "#64708a",
  IR: "#c05a68",
};

export const CALL_COLOR = { Start: "#2ed584", Sit: "#ff5c6c", Flex: "#5b8cff", Waiver: "#5b8cff", Trade: "#a78bfa" };
export const STATUS_LABEL = { "": "ACTIVE", Q: "QUEST", D: "DOUBT", O: "OUT", IR: "IR", BYE: "BYE" };

export const destKey = (d) => `${d.zone}:${d.slotKey || ""}:${d.index}`;
export const zoneLabel = (d) => (d.zone === "lineup" ? d.slotKey : d.zone === "bench" ? "BN" : "IR");
