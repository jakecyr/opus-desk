import { useLayoutEffect, useRef } from 'react';

// Reserve each card's own height so a short card doesn't wait for a taller neighbour.
export function SettingsLayout({ children }) {
  const grid = useRef(null);
  useLayoutEffect(() => {
    const element = grid.current,
      cards = [...element.children];
    let frame;
    function measure() {
      const style = getComputedStyle(element),
        unit = parseFloat(style.gridAutoRows) || 4,
        gap = parseFloat(style.columnGap) || 16;
      for (const card of cards) {
        const rows = String(
          Math.ceil((card.getBoundingClientRect().height + gap) / unit),
        );
        if (card.style.getPropertyValue('--settings-rows') !== rows)
          card.style.setProperty('--settings-rows', rows);
      }
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    cards.forEach((card) => observer.observe(card));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div className="settings-grid" ref={grid}>
      {children}
    </div>
  );
}
