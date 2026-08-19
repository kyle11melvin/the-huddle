// Entry bundled by scripts/smoke.mjs. Exports the real components plus a
// realistic state fixture, so the smoke test renders production code rather
// than a stand-in.
import React from "react";
import { renderToString } from "react-dom/server";
import App from "../src/App.jsx";
import Today from "../src/components/Today.jsx";
import Gameday from "../src/components/Gameday.jsx";
import StartSitLab from "../src/components/StartSitLab.jsx";
import DataPanel from "../src/components/DataPanel.jsx";
import LeagueBrowser from "../src/components/LeagueBrowser.jsx";
import ErrorBoundary from "../src/ErrorBoundary.jsx";
import RosterRow from "../src/components/RosterRow.jsx";
import { MoveSheet, PlayerModal, AddPlayerModal } from "../src/components/modals/index.jsx";

const noop = () => {};

/** Full roster, live snapshot, an opponent, an OUT starter, a bench upgrade. */
export function makeState() {
  // weeks is POPULATED on purpose. A render check only covers the branches
  // the fixture reaches: with weeks empty, PlayerModal's matchup-grade branch
  // never rendered, and a missing <Stars> import passed smoke while crashing
  // in the app. Same reason notes/ecr are non-empty.
  const mk = (id, name, team, pos, status = "") => ({
    id, name, team, pos, ecr: `${pos}12`, status, espnId: id,
    notes: "camp report: looked sharp",
    weeks: { 1: { opp: "vs CLE", matchup: 4 } },
  });
  const P = {
    qb: mk("qb", "Trevor Lawrence", "JAX", "QB"),
    rb1: mk("rb1", "Bijan Robinson", "ATL", "RB"),
    rb2: mk("rb2", "Chase Brown", "CIN", "RB"),
    wr1: mk("wr1", "Tee Higgins", "CIN", "WR"),
    wr2: mk("wr2", "Hurt Guy", "DET", "WR", "O"),
    wr3: mk("wr3", "Parker Washington", "JAX", "WR"),
    te: mk("te", "Brock Bowers", "LV", "TE"),
    flex: mk("flex", "Javonte Williams", "DAL", "RB"),
    dst: mk("dst", "Steelers D/ST", "PIT", "D/ST"),
    k: mk("k", "Cameron Dicker", "LAC", "K"),
    b1: mk("b1", "Quentin Johnston", "LAC", "WR"),
    b2: mk("b2", "Romeo Doubs", "GB", "WR", "Q"),
  };
  const projFor = {
    qb: 20.6, rb1: 19.8, rb2: 15.1, wr1: 14.2, wr2: 12.7, wr3: 6.4,
    te: 16.3, flex: 11.9, dst: 7.5, k: 8.8, b1: 13.9, b2: 8.9,
  };
  const analytics = {};
  for (const id of Object.keys(P)) {
    analytics[id] = { 1: { proj: projFor[id], projSource: "espn", projBasis: "weekly", fpProj: projFor[id] - 1.4 } };
  }
  const games = {};
  for (const t of ["JAX", "ATL", "CIN", "DET", "LV", "DAL", "PIT", "LAC", "GB", "KC"]) {
    games[t] = { state: "pre", pctRemaining: 1, detail: "Sun 1:00 PM EDT", startTime: new Date(Date.now() + 7200e3).toISOString() };
  }
  const oppRoster = [
    ["Opp QB", "QB", "QB", 18], ["Opp RB1", "RB", "RB", 14], ["Opp RB2", "RB", "RB", 10],
    ["Opp WR1", "WR", "WR", 13], ["Opp WR2", "WR", "WR", 11], ["Opp WR3", "WR", "WR", 9],
    ["Opp TE", "TE", "TE", 8], ["Opp FX", "RB", "FLEX", 9], ["Opp DST", "D/ST", "D/ST", 7],
    ["Opp K", "K", "K", 8], ["Opp Bench", "WR", "BE", 15],
  ].map(([name, pos, slot, proj], i) => ({
    name, pos, slot, proj, actual: null, espnId: `o${i}`,
    injuryStatus: name === "Opp WR3" ? "OUT" : "", team: "KC", percentOwned: 40,
  }));

  return {
    v: 2, week: "1", players: P,
    lineup: { QB: ["qb"], RB: ["rb1", "rb2"], WR: ["wr1", "wr2", "wr3"], TE: ["te"], FLEX: ["flex"], "D/ST": ["dst"], K: ["k"] },
    bench: ["b1", "b2", null, null, null, null], ir: [null, null],
    watch: [{ id: "w1", name: "Tank Bigsby", team: "PHI", pos: "RB", note: "" }],
    calls: [{ id: "c1", player: "Bijan Robinson", week: "1", type: "Start", reasoning: "volume", confidence: 4, outcome: "right" }],
    faab: 99,
    claims: [{ id: "cl1", player: "Tank Bigsby", team: "PHI", pos: "RB", amount: "5", result: "Pending", note: "" }],
    byes: { GB: 5 }, byesAuto: { GB: 5 }, byesManual: {},
    ecrIndex: { tankbigsby: 40 }, analytics,
    matchups: { 1: { oppTeam: "Rivals" } },
    espn: {
      fetchedAt: Date.now(), currentWeek: 1, myTeamId: 7, scoring: { passTd: 6, int: -3, reception: 1 },
      leagueFaab: 100, games,
      teams: [
        { id: 7, name: "Maye-Be This Is Our Year", mapped: "Maye-Be This Is Our Year", record: { w: 0, l: 0, t: 0 }, faabSpent: 1, roster: [] },
        { id: 2, name: "Rivals", mapped: "Rivals", record: { w: 0, l: 0, t: 0 }, faabSpent: 0, roster: oppRoster },
      ],
      matchups: [{ home: 7, away: 2, homeScore: 0, awayScore: 0 }],
      impliedTotals: { KC: 26.5, CIN: 25, JAX: 21.5 },
      pool: [{ espnId: "p1", name: "Tank Bigsby", pos: "RB", proTeamId: 21, team: "PHI", onTeamId: 0, percentOwned: 16, proj: 4.8 }],
      autoRanks: { tankbigsby: 55 },
    },
    schedule: { opps: { 1: { JAX: "CLE", CIN: "@TB" } }, fetchedAt: Date.now(), season: "2026" },
    alertsDismissed: {}, calibration: {}, projWeights: null, orphans: [],
  };
}

/** [label, Component, props] for every screen that can crash on its own. */
export function screens(state) {
  const week = "1";
  return [
    ["Today (Command Center)", Today, { state, week, onApplyMove: noop, onSetLive: noop, onSetOpponent: noop, onRefresh: noop, onOpenPlayer: noop }],
    ["Gameday board", Gameday, { state, week, onSetLive: noop, onSetOpponent: noop, onRefresh: noop }],
    ["Start/Sit Lab", StartSitLab, { state, week, onImport: noop, onApplySwap: noop, flash: noop }],
    ["Data panel", DataPanel, { state, onClose: noop, onApplyEcr: noop, onApplyByes: noop, onSetBye: noop, onImportTeam: noop, onApplyProps: noop, onApplyProjections: noop, flash: noop, link: null, syncStatus: "", syncError: "", onGoLive: noop, onStopLive: noop, onJoinTeam: noop, onRefreshLive: noop, liveUrl: "" }],
    ["League browser", LeagueBrowser, { state, ecrIndex: {}, interested: state.watch, onToggleInterest: noop }],
    ["Error boundary (passthrough)", ErrorBoundary, { children: React.createElement("div", null, "ok") }],
    // Modals and rows render ONLY on interaction, so <App/> alone never
    // reaches them — an extraction that dropped an import shipped a crash
    // that opened with the player modal and no check saw it. Rendered
    // directly now.
    ["Player modal", PlayerModal, { state, playerId: "wr1", week, onClose: noop, onStatus: noop, onWeek: noop, onMoveOpen: noop, onDrop: noop, onEdit: noop }],
    ["Move sheet", MoveSheet, { state, playerId: "b1", week, onClose: noop, onMove: noop, coarse: false }],
    ["Move sheet (touch)", MoveSheet, { state, playerId: "b1", week, onClose: noop, onMove: noop, coarse: true }],
    ["Add player modal", AddPlayerModal, { state, onClose: noop, onAdd: noop }],
    ["Roster row (filled)", RosterRow, { dest: { zone: "lineup", slotKey: "WR", index: 0 }, player: state.players.wr1, week, byes: state.byes, oppFor: () => "vs CLE", projFor: () => 14.2, index: 0, dragId: null, legalKeys: new Set(), onOpen: noop, onBadge: noop, onDragStart: noop, onDragEnd: noop, onDrop: noop, coarse: false }],
    ["Roster row (empty slot)", RosterRow, { dest: { zone: "bench", index: 3 }, player: null, week, byes: state.byes, oppFor: () => "", projFor: () => null, index: 1, dragId: null, legalKeys: new Set(), onOpen: noop, onBadge: noop, onDragStart: noop, onDragEnd: noop, onDrop: noop, coarse: true }],
  ];
}

export { React, renderToString, App };
