// Shared display constants and tiny helpers.
//
// Extracted from App.jsx (review finding: code health, step 2). SLOT_COLOR was
// also duplicated verbatim in LeagueBrowser.jsx — one definition now.
// One colour per position, used EVERYWHERE — slot badges, the identity line,
// chips. From the approved matchup reference: TE is orange and FLEX violet,
// which is the Sleeper convention and what the design was signed off against.
export const SLOT_COLOR = {
  QB: "#e8657a",
  RB: "#5cc79a",
  WR: "#5b9be8",
  TE: "#e89a4a",
  FLEX: "#a97fe8",
  "D/ST": "#8fa1ba",
  K: "#7fc4c4",
  BN: "#64708a",
  IR: "#c05a68",
};

export const CALL_COLOR = { Start: "#2ed584", Sit: "#ff5c6c", Flex: "#5b8cff", Waiver: "#5b8cff", Trade: "#a78bfa" };
export const STATUS_LABEL = { "": "ACTIVE", Q: "QUEST", D: "DOUBT", O: "OUT", IR: "IR", BYE: "BYE" };

export const destKey = (d) => `${d.zone}:${d.slotKey || ""}:${d.index}`;
export const zoneLabel = (d) => (d.zone === "lineup" ? d.slotKey : d.zone === "bench" ? "BN" : "IR");
