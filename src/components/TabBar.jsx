import React, { useState } from "react";

/**
 * The 5-item bottom tab bar DESIGN.md has locked since Sept 10, and which the
 * app never had: seven pill tabs sat in a strip at the TOP of the screen —
 * the hardest reach one-handed — and three of them (Watchlist, Waivers,
 * Game Log) were off-screen until you swiped a strip that did not look
 * swipeable. The four most-used tabs get a button each; the rest live under
 * More, which lights up whenever one of them is the open tab.
 */
const MAIN = [
  ["today", "Today"],
  ["roster", "Roster"],
  ["lab", "Start/Sit"],
  ["intel", "Intel"],
];
const MORE = [
  ["watch", "Watchlist"],
  ["waivers", "Waivers"],
  ["log", "Game Log"],
];

// Plain line icons, drawn once here — the app has no icon set to borrow from.
const ICON = {
  today: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  roster: <path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01" />,
  lab: <path d="M7 4v16M7 4 3.5 7.5M7 4l3.5 3.5M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5" />,
  intel: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
    </g>
  ),
};

const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="tabbar-ico">
    {ICON[name]}
  </svg>
);

export default function TabBar({ tab, onTab }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const inMore = MORE.some(([k]) => k === tab);
  const go = (k) => {
    setMoreOpen(false);
    onTab(k);
  };

  return (
    <>
      {moreOpen && (
        <>
          <button type="button" className="tabbar-scrim" aria-label="Close menu" onClick={() => setMoreOpen(false)} />
          <div className="tabbar-more" role="menu">
            {MORE.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="menuitem"
                className={`tabbar-more-btn ${tab === k ? "active" : ""}`}
                onClick={() => go(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <nav className="tabbar" aria-label="Sections">
        <div className="tabbar-inner">
          {MAIN.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`tabbar-btn ${tab === k ? "active" : ""}`}
              aria-current={tab === k ? "page" : undefined}
              onClick={() => go(k)}
            >
              <Icon name={k} />
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`tabbar-btn ${inMore ? "active" : ""}`}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <Icon name="more" />
            {inMore ? MORE.find(([k]) => k === tab)[1] : "More"}
          </button>
        </div>
      </nav>
    </>
  );
}
