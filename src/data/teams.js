// NFL team identity — real team colors + ESPN CDN slugs.
// `ring` is the color used for headshot rings / chips, hand-picked from each
// team's palette for contrast against the dark UI.

export const TEAMS = {
  ARI: { name: "Cardinals", primary: "#97233F", secondary: "#FFB612", ring: "#C8375E", slug: "ari" },
  ATL: { name: "Falcons", primary: "#A71930", secondary: "#000000", ring: "#E03A50", slug: "atl" },
  BAL: { name: "Ravens", primary: "#241773", secondary: "#9E7C0C", ring: "#7B68D9", slug: "bal" },
  BUF: { name: "Bills", primary: "#00338D", secondary: "#C60C30", ring: "#4D7FE0", slug: "buf" },
  CAR: { name: "Panthers", primary: "#0085CA", secondary: "#101820", ring: "#2BA3E8", slug: "car" },
  CHI: { name: "Bears", primary: "#0B162A", secondary: "#C83803", ring: "#E85A2A", slug: "chi" },
  CIN: { name: "Bengals", primary: "#FB4F14", secondary: "#000000", ring: "#FB4F14", slug: "cin" },
  CLE: { name: "Browns", primary: "#311D00", secondary: "#FF3C00", ring: "#FF3C00", slug: "cle" },
  DAL: { name: "Cowboys", primary: "#003594", secondary: "#869397", ring: "#4D7FE0", slug: "dal" },
  DEN: { name: "Broncos", primary: "#FB4F14", secondary: "#002244", ring: "#FB4F14", slug: "den" },
  DET: { name: "Lions", primary: "#0076B6", secondary: "#B0B7BC", ring: "#2E9BDC", slug: "det" },
  GB:  { name: "Packers", primary: "#203731", secondary: "#FFB612", ring: "#FFB612", slug: "gb" },
  HOU: { name: "Texans", primary: "#03202F", secondary: "#A71930", ring: "#D93A55", slug: "hou" },
  IND: { name: "Colts", primary: "#002C5F", secondary: "#A2AAAD", ring: "#4D7FE0", slug: "ind" },
  JAX: { name: "Jaguars", primary: "#006778", secondary: "#D7A22A", ring: "#0FA3B8", slug: "jax" },
  KC:  { name: "Chiefs", primary: "#E31837", secondary: "#FFB81C", ring: "#E31837", slug: "kc" },
  LAC: { name: "Chargers", primary: "#0080C6", secondary: "#FFC20E", ring: "#2BA3E8", slug: "lac" },
  LAR: { name: "Rams", primary: "#003594", secondary: "#FFA300", ring: "#FFA300", slug: "lar" },
  LV:  { name: "Raiders", primary: "#000000", secondary: "#A5ACAF", ring: "#C7CDD1", slug: "lv" },
  MIA: { name: "Dolphins", primary: "#008E97", secondary: "#FC4C02", ring: "#0FB3BE", slug: "mia" },
  MIN: { name: "Vikings", primary: "#4F2683", secondary: "#FFC62F", ring: "#8A5AD6", slug: "min" },
  NE:  { name: "Patriots", primary: "#002244", secondary: "#C60C30", ring: "#D93A55", slug: "ne" },
  NO:  { name: "Saints", primary: "#D3BC8D", secondary: "#101820", ring: "#D3BC8D", slug: "no" },
  NYG: { name: "Giants", primary: "#0B2265", secondary: "#A71930", ring: "#4D7FE0", slug: "nyg" },
  NYJ: { name: "Jets", primary: "#125740", secondary: "#000000", ring: "#1FA574", slug: "nyj" },
  PHI: { name: "Eagles", primary: "#004C54", secondary: "#A5ACAF", ring: "#0F9AA8", slug: "phi" },
  PIT: { name: "Steelers", primary: "#FFB612", secondary: "#101820", ring: "#FFB612", slug: "pit" },
  SEA: { name: "Seahawks", primary: "#002244", secondary: "#69BE28", ring: "#69BE28", slug: "sea" },
  SF:  { name: "49ers", primary: "#AA0000", secondary: "#B3995D", ring: "#D93030", slug: "sf" },
  TB:  { name: "Buccaneers", primary: "#D50A0A", secondary: "#34302B", ring: "#E83030", slug: "tb" },
  TEN: { name: "Titans", primary: "#0C2340", secondary: "#4B92DB", ring: "#4B92DB", slug: "ten" },
  WSH: { name: "Commanders", primary: "#5A1414", secondary: "#FFB612", ring: "#D9A014", slug: "wsh" },
};

export function teamOf(abbr) {
  return TEAMS[abbr] || { name: abbr, primary: "#3A4356", secondary: "#8B93A1", ring: "#5B6472", slug: null };
}

export function headshotUrl(espnId) {
  return espnId ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png` : null;
}

export function teamLogoUrl(abbr) {
  const t = TEAMS[abbr];
  return t ? `https://a.espncdn.com/i/teamlogos/nfl/500/${t.slug}.png` : null;
}
