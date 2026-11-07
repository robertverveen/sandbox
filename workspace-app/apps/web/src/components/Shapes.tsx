/** Vormen van de website achter het vilt (PAYOFF_SHAPES in het prototype). */
export function PayoffShapes() {
  return (
    <div className="shapes" aria-hidden="true">
      <svg viewBox="0 0 300 300" style={{ right: 0, top: 0, width: 200, height: 200 }}>
        <path d="M300 0V210A210 210 0 0 1 90 0Z" fill="#0022c4" />
      </svg>
      <svg viewBox="0 0 300 300" style={{ right: 120, bottom: 0, width: 120, height: 120 }}>
        <circle cx="150" cy="300" r="110" fill="none" stroke="#f9b20b" strokeWidth="30" />
      </svg>
    </div>
  );
}
