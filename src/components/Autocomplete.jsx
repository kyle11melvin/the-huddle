import { useState, useRef, useEffect } from "react";

/**
 * Typeahead with free-text fallback: whatever is typed is always kept as the
 * value; picking a suggestion additionally reports the structured record.
 *
 * @param {(q:string)=>Array<{name,team,pos}>} search
 */
export default function Autocomplete({ value, onChange, onPick, search, placeholder, style, limit = 8 }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onDocDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, []);

  const recompute = (q) => {
    const next = search(q, limit);
    setItems(next);
    setActive(next.length ? 0 : -1);
    setOpen(next.length > 0);
  };

  const handleChange = (e) => {
    const q = e.target.value;
    onChange(q);
    recompute(q);
  };

  const choose = (item) => {
    onChange(item.name);
    onPick?.(item);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      if (active >= 0) {
        e.preventDefault();
        choose(items[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="ac-wrap" ref={wrapRef} style={style}>
      <input
        value={value}
        onChange={handleChange}
        onFocus={() => value && recompute(value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck="false"
        style={{ width: "100%" }}
      />
      {open && (
        <div className="ac-menu">
          {items.map((item, i) => (
            <button
              key={`${item.name}-${item.team}-${i}`}
              type="button"
              className={`ac-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className="ac-name">{item.name}</span>
              <span className="ac-meta">
                {item.badge && <span className="ac-badge">{item.badge}</span>}
                {item.pos} · {item.team}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
