// ============================================================================
// Whales Vagina Fantasy FB — all 10 rosters.
//
// SOURCE: transcribed by hand from ESPN league screenshots (Aug 2026, week of
// the season opener, all teams 0-0-0). Teams/positions are exactly as ESPN
// displayed them.
//
// This is a SNAPSHOT, not a feed. Every add/drop in the league makes it a
// little more wrong. It drives "is this player actually available?" and the
// trade/strength views — when it looks stale, re-paste it from ESPN via the
// Data panel, or re-transcribe here. Not protected data; edit freely.
//
// Format: [name, team, pos]  (slot order: QB RB RB WR WR WR TE FLEX D/ST K,
// then bench, then IR — but only name/team/pos are load-bearing here.)
// ============================================================================

export const MY_TEAM = "Maye-Be This Is Our Year";

export const LEAGUE_ROSTERS = [
  {
    team: "Substation",
    starters: [
      ["Dak Prescott", "DAL", "QB"],
      ["Jonathan Taylor", "IND", "RB"],
      ["Kyren Williams", "LAR", "RB"],
      ["Nico Collins", "HOU", "WR"],
      ["Chris Olave", "NO", "WR"],
      ["Mike Evans", "SF", "WR"],
      ["Tyler Warren", "IND", "TE"],
      ["Quinshon Judkins", "CLE", "RB"],
      ["Rams D/ST", "LAR", "D/ST"],
      ["Eddy Pineiro", "SF", "K"],
    ],
    bench: [
      ["Brock Purdy", "SF", "QB"],
      ["Wan'Dale Robinson", "TEN", "WR"],
      ["Rhamondre Stevenson", "NE", "RB"],
      ["Isaiah Likely", "NYG", "TE"],
      ["Stefon Diggs", "WSH", "WR"],
      ["De'Zhaun Stribling", "SF", "WR"],
    ],
    ir: [],
  },
  {
    team: MY_TEAM,
    starters: [
      ["Trevor Lawrence", "JAX", "QB"],
      ["Bijan Robinson", "ATL", "RB"],
      ["Chase Brown", "CIN", "RB"],
      ["Tee Higgins", "CIN", "WR"],
      ["Jameson Williams", "DET", "WR"],
      ["Parker Washington", "JAX", "WR"],
      ["Brock Bowers", "LV", "TE"],
      ["Javonte Williams", "DAL", "RB"],
      ["Steelers D/ST", "PIT", "D/ST"],
      ["Cameron Dicker", "LAC", "K"],
    ],
    bench: [
      ["Quentin Johnston", "LAC", "WR"],
      ["Makai Lemon", "PHI", "WR"],
      ["Rachaad White", "WSH", "RB"],
      ["Brian Robinson Jr.", "ATL", "RB"],
      ["Romeo Doubs", "NE", "WR"],
      ["Jayden Higgins", "HOU", "WR"],
    ],
    ir: [],
  },
  {
    team: "BennyBalls",
    starters: [
      ["Jayden Daniels", "WSH", "QB"],
      ["Breece Hall", "NYJ", "RB"],
      ["David Montgomery", "HOU", "RB"],
      ["Puka Nacua", "LAR", "WR"],
      ["Malik Nabers", "NYG", "WR"],
      ["Jordan Addison", "MIN", "WR"],
      ["Sam LaPorta", "DET", "TE"],
      ["Brashard Smith", "KC", "RB"],
      ["Bills D/ST", "BUF", "D/ST"],
      ["Brandon Aubrey", "DAL", "K"],
    ],
    bench: [
      ["Isiah Pacheco", "DET", "RB"],
      ["Khalil Shakir", "BUF", "WR"],
      ["RJ Harvey", "DEN", "RB"],
      ["Ray Davis", "BUF", "RB"],
      ["Blake Corum", "LAR", "RB"],
      ["Cyrus Allen", "KC", "WR"],
    ],
    ir: [],
  },
  {
    team: "Donkey Beers",
    starters: [
      ["Bo Nix", "DEN", "QB"],
      ["Christian McCaffrey", "SF", "RB"],
      ["James Cook III", "BUF", "RB"],
      ["Rashee Rice", "KC", "WR"],
      ["Jaylen Waddle", "DEN", "WR"],
      ["Marvin Harrison Jr.", "ARI", "WR"],
      ["Kyle Pitts Sr.", "ATL", "TE"],
      ["Travis Etienne Jr.", "NO", "RB"],
      ["Jaguars D/ST", "JAX", "D/ST"],
      ["Cam Little", "JAX", "K"],
    ],
    bench: [
      ["Luther Burden III", "CHI", "WR"],
      ["Chris Godwin Jr.", "TB", "WR"],
      ["Travis Kelce", "KC", "TE"],
      ["Kyle Monangai", "CHI", "RB"],
      ["Tyjae Spears", "TEN", "RB"],
      ["Deebo Samuel Sr.", "SF", "WR"],
    ],
    ir: [],
  },
  {
    team: "Give Me All The TD's",
    starters: [
      ["Matthew Stafford", "LAR", "QB"],
      ["De'Von Achane", "MIA", "RB"],
      ["Ashton Jeanty", "LV", "RB"],
      ["CeeDee Lamb", "DAL", "WR"],
      ["Davante Adams", "LAR", "WR"],
      ["Terry McLaurin", "WSH", "WR"],
      ["Harold Fannin Jr.", "CLE", "TE"],
      ["Kenneth Walker III", "KC", "RB"],
      ["Lions D/ST", "DET", "D/ST"],
      ["Jake Bates", "DET", "K"],
    ],
    bench: [
      ["Brian Thomas Jr.", "JAX", "WR"],
      ["J.K. Dobbins", "DEN", "RB"],
      ["Aaron Jones Sr.", "MIN", "RB"],
      ["Jaxson Dart", "NYG", "QB"],
      ["Jake Ferguson", "DAL", "TE"],
      ["Jordan Mason", "MIN", "RB"],
    ],
    ir: [],
  },
  {
    team: "Bros In Skirts",
    starters: [
      ["Lamar Jackson", "BAL", "QB"],
      ["D'Andre Swift", "CHI", "RB"],
      ["Jadarian Price", "SEA", "RB"],
      ["Jaxon Smith-Njigba", "SEA", "WR"],
      ["A.J. Brown", "NE", "WR"],
      ["Drake London", "ATL", "WR"],
      ["George Kittle", "SF", "TE"],
      ["Courtland Sutton", "DEN", "WR"],
      ["Texans D/ST", "HOU", "D/ST"],
      ["Ka'imi Fairbairn", "HOU", "K"],
    ],
    bench: [
      ["Tony Pollard", "TEN", "RB"],
      ["Justin Herbert", "LAC", "QB"],
      ["Cooper Kupp", "SEA", "WR"],
      ["Josh Downs", "IND", "WR"],
      ["James Conner", "ARI", "RB"],
      ["Evan Engram", "DEN", "TE"],
    ],
    ir: [],
  },
  {
    team: "Heading To Dee Waffle House",
    starters: [
      ["Joe Burrow", "CIN", "QB"],
      ["Saquon Barkley", "PHI", "RB"],
      ["Omarion Hampton", "LAC", "RB"],
      ["Ja'Marr Chase", "CIN", "WR"],
      ["Garrett Wilson", "NYJ", "WR"],
      ["Zay Flowers", "BAL", "WR"],
      ["Colston Loveland", "CHI", "TE"],
      ["DK Metcalf", "PIT", "WR"],
      ["Eagles D/ST", "PHI", "D/ST"],
      ["Tyler Loop", "BAL", "K"],
    ],
    bench: [
      ["TreVeyon Henderson", "NE", "RB"],
      ["Jordyn Tyson", "NO", "WR"],
      ["Rico Dowdle", "PIT", "RB"],
      ["Michael Wilson", "ARI", "WR"],
      ["Jonathon Brooks", "CAR", "RB"],
      ["Caleb Williams", "CHI", "QB"],
    ],
    ir: [],
  },
  {
    team: "Dippity Tippity",
    starters: [
      ["Josh Allen", "BUF", "QB"],
      ["Cam Skattebo", "NYG", "RB"],
      ["Jaylen Warren", "PIT", "RB"],
      ["Justin Jefferson", "MIN", "WR"],
      ["Emeka Egbuka", "TB", "WR"],
      ["Ladd McConkey", "LAC", "WR"],
      ["Dallas Goedert", "PHI", "TE"],
      ["Bucky Irving", "TB", "RB"],
      ["Broncos D/ST", "DEN", "D/ST"],
      ["Jason Myers", "SEA", "K"],
    ],
    bench: [
      ["Michael Pittman Jr.", "PIT", "WR"],
      ["Matthew Golden", "GB", "WR"],
      ["Kenny Gainwell", "TB", "RB"],
      ["Alvin Kamara", "NO", "RB"],
      ["Tyrone Tracy Jr.", "NYG", "RB"],
      ["George Holani", "SEA", "RB"],
    ],
    ir: [["Tucker Kraft", "GB", "TE"]],
  },
  {
    team: "PURDYS PANTYHOES",
    starters: [
      ["Jalen Hurts", "PHI", "QB"],
      ["Jahmyr Gibbs", "DET", "RB"],
      ["Derrick Henry", "BAL", "RB"],
      ["Tetairoa McMillan", "CAR", "WR"],
      ["DeVonta Smith", "PHI", "WR"],
      ["Carnell Tate", "TEN", "WR"],
      ["Trey McBride", "ARI", "TE"],
      ["Chuba Hubbard", "CAR", "RB"],
      ["Seahawks D/ST", "SEA", "D/ST"],
      ["Matt Gay", "LV", "K"],
    ],
    bench: [
      ["DJ Moore", "BUF", "WR"],
      ["Christian Watson", "GB", "WR"],
      ["Jakobi Meyers", "JAX", "WR"],
      ["Jerry Jeudy", "CLE", "WR"],
      ["Marvin Mims Jr.", "DEN", "WR"],
    ],
    ir: [],
  },
  {
    team: "Knoll And Void",
    starters: [
      ["Drake Maye", "NE", "QB"],
      ["Jeremiyah Love", "ARI", "RB"],
      ["Josh Jacobs", "GB", "RB"],
      ["Amon-Ra St. Brown", "DET", "WR"],
      ["George Pickens", "DAL", "WR"],
      ["Rome Odunze", "CHI", "WR"],
      ["Mark Andrews", "BAL", "TE"],
      ["Bhayshul Tuten", "JAX", "RB"],
      ["Ravens D/ST", "BAL", "D/ST"],
      ["Harrison Butker", "KC", "K"],
    ],
    bench: [
      ["Travis Hunter", "JAX", "WR"],
      ["Hunter Henry", "NE", "TE"],
      ["Jacory Croskey-Merritt", "WSH", "RB"],
      ["Woody Marks", "HOU", "RB"],
      ["Tyler Allgeier", "ARI", "RB"],
      ["MarShawn Lloyd", "GB", "RB"],
    ],
    ir: [
      ["Alec Pierce", "IND", "WR"],
      ["Zach Charbonnet", "SEA", "RB"],
    ],
  },
];

/**
 * Players ESPN listed as genuinely available at transcription time. Used to
 * correct team assignments in the generated free-agent pool and to seed the
 * "verified available" badge.
 */
export const VERIFIED_FREE_AGENTS = [
  ["Patrick Mahomes", "KC", "QB"],
  ["Jared Goff", "DET", "QB"],
  ["Jordan Love", "GB", "QB"],
  ["Kyler Murray", "MIN", "QB"],
  ["Baker Mayfield", "TB", "QB"],
  ["Sam Darnold", "SEA", "QB"],
  ["C.J. Stroud", "HOU", "QB"],
  ["Daniel Jones", "IND", "QB"],
  ["Tyler Shough", "NO", "QB"],
  ["Malik Willis", "MIA", "QB"],
  ["Fernando Mendoza", "LV", "QB"],
  ["T.J. Hockenson", "MIN", "TE"],
  ["Dalton Kincaid", "BUF", "TE"],
  ["Juwan Johnson", "NO", "TE"],
  ["Brenton Strange", "JAX", "TE"],
  ["Terrance Ferguson", "LAR", "TE"],
  ["Kenyon Sadiq", "NYJ", "TE"],
  ["Xavier Worthy", "KC", "WR"],
  ["Jayden Reed", "GB", "WR"],
  ["Calvin Ridley", "TEN", "WR"],
  ["Rashid Shaheed", "SEA", "WR"],
  ["Jalen Coker", "CAR", "WR"],
  ["Jalen McMillan", "TB", "WR"],
  ["Tank Dell", "HOU", "WR"],
  ["Tre Tucker", "LV", "WR"],
  ["KC Concepcion", "CLE", "WR"],
  ["Denzel Boston", "CLE", "WR"],
  ["Omar Cooper Jr.", "NYJ", "WR"],
  ["Ricky Pearsall", "SF", "WR"],
  ["Tank Bigsby", "PHI", "RB"],
  ["Chris Rodriguez Jr.", "JAX", "RB"],
  ["Chris Boswell", "PIT", "K"],
  ["Evan McPherson", "CIN", "K"],
  ["Cairo Santos", "CHI", "K"],
  ["Will Reichard", "MIN", "K"],
  ["Chase McLaughlin", "TB", "K"],
  ["Harrison Mevis", "LAR", "K"],
  ["Patriots D/ST", "NE", "D/ST"],
  ["Browns D/ST", "CLE", "D/ST"],
  ["Chargers D/ST", "LAC", "D/ST"],
  ["Chiefs D/ST", "KC", "D/ST"],
  ["Vikings D/ST", "MIN", "D/ST"],
  ["Packers D/ST", "GB", "D/ST"],
];

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

/** name(normalized) -> owning fantasy team */
const OWNER_INDEX = (() => {
  const m = new Map();
  for (const t of LEAGUE_ROSTERS) {
    for (const group of [t.starters, t.bench, t.ir]) {
      for (const [name] of group || []) m.set(norm(name), t.team);
    }
  }
  return m;
})();

const VERIFIED_INDEX = new Set(VERIFIED_FREE_AGENTS.map(([n]) => norm(n)));

/** Which fantasy team rosters this player, or null if nobody in the league does. */
export function whoRosters(playerName) {
  return OWNER_INDEX.get(norm(playerName)) || null;
}

/** True when ESPN explicitly showed this player as a free agent. */
export function isVerifiedAvailable(playerName) {
  return VERIFIED_INDEX.has(norm(playerName));
}

/** Corrected team for players where the generated pool disagreed with ESPN. */
export function verifiedTeam(playerName) {
  const hit = VERIFIED_FREE_AGENTS.find(([n]) => norm(n) === norm(playerName));
  return hit ? hit[1] : null;
}

export const LEAGUE_SIZE = LEAGUE_ROSTERS.length;
