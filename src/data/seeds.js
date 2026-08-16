// ============================================================================
// SEED DATA — protected. Do not edit player data, scout notes, or IDs.
// Copied verbatim from the original Claude artifact (the-huddle.jsx).
// ============================================================================

export const STATUS_TAGS = ["", "Q", "D", "O", "IR", "BYE"];
export const CALL_TYPES = ["Start", "Sit", "Flex", "Waiver", "Trade"];

export const SEED_STARTERS = [
  { id: "s0", slot: "QB", name: "Trevor Lawrence", team: "JAX", status: "", espnId: "4360310", ecr: "QB11", matchup: 2, opp: "CLE",
    notes: "VERIFIED (Aug '26 camp, Day 3): HC Liam Coen — \"He's seeing it really well right now.\" Multiple reports have Lawrence and the offense \"significantly ahead\" of last year's camp pace, with growing chemistry to Brian Thomas Jr. No red flags, clean camp." },
  { id: "s1", slot: "RB", name: "Bijan Robinson", team: "ATL", status: "", espnId: "4430807", ecr: "RB2", matchup: 2, opp: "@PIT",
    notes: "VERIFIED: signed a new contract extension the week of Aug 3 after briefly sitting out camp over the deal. Back at practice and \"looked sharp\" per Falcons camp report (Aug 7) — situation fully resolved, no missed-time risk from this." },
  { id: "s2", slot: "RB", name: "Chase Brown", team: "CIN", status: "", espnId: "4362238", ecr: "RB9", matchup: 3, opp: "TB",
    notes: "VERIFIED: averaged 104.7 combined yards/game over final 11 games of 2025 per Bengals camp notes; QB Joe Burrow: \"I can't say enough good things about him.\" Contract-extension conversations ongoing (per Yahoo, Aug 9) but not tied to reps — he's still the clear lead back in camp." },
  { id: "s3", slot: "WR", name: "Tee Higgins", team: "CIN", status: "", espnId: "4239993", ecr: "WR14", matchup: 2, opp: "TB",
    notes: "VERIFIED: caught a contested TD from Burrow in the Aug 9 practice ('basketball player,' per WR coach Troy Walters). Healthy, full camp workload, expected to see preseason snaps in the opener vs. Detroit." },
  { id: "s4", slot: "WR", name: "Jameson Williams", team: "DET", status: "", espnId: "4426388", ecr: "WR24", matchup: 4, opp: "NO",
    notes: "VERIFIED: multiple Lions beat reporters (Detroit Lions team site, Pride of Detroit) have flagged him as one of the standout performers through camp, including a highlight TD grab in the first two weeks. Coming off back-to-back 1,000-yard seasons." },
  {
    id: "s5", slot: "WR", name: "Parker Washington", team: "JAX", status: "", espnId: "4432620", ecr: "WR33", matchup: 4, opp: "CLE",
    notes:
      "VERIFIED (Aug '26 camp): HC Liam Coen — \"If the Jaguars do have a WR1, it is likely Washington\" after he beat Travis Hunter deep for a TD in 11-on-11s. Coen also said Washington texted him \"I'm ready to kill.\" Depth chart still lists him 4th, but camp reports + Lawrence's 3rd-down trust say otherwise.",
  },
  { id: "s6", slot: "TE", name: "Brock Bowers", team: "LV", status: "", espnId: "4432665", ecr: "TE1", matchup: 3, opp: "MIA",
    notes: "ESPN camp notes: coordinator plans to use Bowers and Michael Mayer together often; team wants him established as the clear #1 passing-game threat given uncertainty elsewhere in the WR room." },
  { id: "s7", slot: "FLEX", name: "Javonte Williams", team: "DAL", status: "", espnId: "4361579", ecr: "RB14", matchup: 4, opp: "@NYG",
    notes: "VERIFIED: confirmed as Dallas's projected starting RB per most recent unofficial depth chart (SI Cowboys, Aug '26). ESPN camp notes: 2nd-year back Jaydon Blue is not viewed as a real threat to his workload." },
  { id: "s8", slot: "D/ST", name: "Steelers", team: "PIT", status: "", espnId: "", ecr: "DST9", matchup: 3, opp: "ATL",
    notes: "" },
  { id: "s9", slot: "K", name: "Cameron Dicker", team: "LAC", status: "", espnId: "4362081", ecr: "K3", matchup: 3, opp: "ARI",
    notes: "" },
];

export const SEED_BENCH = [
  {
    id: "b0", pos: "WR", name: "Quentin Johnston", team: "LAC", status: "", espnId: "4429025", ecr: "WR38", matchup: 3, opp: "ARI",
    notes:
      "VERIFIED (May '26): OC Mike McDaniel — \"traits similar to some very powerful, explosive, productive receivers I've had in the past, namely Julio [Jones] and Andre [Johnson].\" Real quote from the playcaller, not fan hype — but it's an offseason trait comp, not a camp target-share report yet.",
  },
  { id: "b1", pos: "WR", name: "Makai Lemon", team: "PHI", status: "Q", espnId: "4870795", ecr: "WR41", matchup: 4, opp: "WAS",
    notes: "CAUTION: hamstring injury has kept him sidelined for over a week of camp per ESPN/Eagles beat reports (as of early Aug). Depth chart buzz around him as a possible WR2 predates the injury — treat that upside as on hold until he's back to full reps." },
  { id: "b2", pos: "RB", name: "Rachaad White", team: "WSH", status: "", espnId: "4697815", ecr: "RB39", matchup: 3, opp: "@PHI",
    notes: "Murkier role in a Washington committee backfield with Bucky Irving in town. More replaceable off waivers than a clean handcuff." },
  { id: "b3", pos: "RB", name: "Brian Robinson Jr.", team: "ATL", status: "", espnId: "4241474", ecr: "RB51", matchup: 2, opp: "@PIT",
    notes: "Bijan's direct handcuff — would step into a top-10 RB role immediately if Bijan were out. Clean, high-value stash, especially now that Bijan's new deal removes any hold-in risk." },
  { id: "b4", pos: "WR", name: "Romeo Doubs", team: "NE", status: "", espnId: "4361432", ecr: "WR50", matchup: 2, opp: "@SEA",
    notes: "Lands in a crowded Patriots WR room. Early-camp role still sorting itself out." },
  { id: "b5", pos: "WR", name: "Jayden Higgins", team: "HOU", status: "", espnId: "4877706", ecr: "WR49", matchup: 3, opp: "BUF",
    notes: "Second-year Texan; camp reports frame him as a talented swing piece worth stashing in deeper leagues." },
];

export const SEED_WATCH = [
  { id: "w0", name: "Tank Bigsby", team: "PHI", note: "Barkley's backup — one injury from real volume, typically <50% rostered." },
  { id: "w1", name: "Braelon Allen", team: "NYJ", note: "Jets committee back, cheap FAAB stash." },
  { id: "w2", name: "Blake Corum", team: "LAR", note: "Kyren Williams' backup, low-rostered nationally." },
];
