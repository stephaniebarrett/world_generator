// The right-hand panel: drag its left edge to change its width, click a section heading to fold the section.
// Both choices are remembered in this browser.

export const MIN_SIDE_WIDTH = 180;
export const MAX_SIDE_WIDTH = 560;
const WIDTH_KEY = 'world-generator.sideWidth';
const FOLDED_KEY = 'world-generator.foldedSections';

export function clampSideWidth(width: number, viewportWidth: number): number {
  // Leave room for the toolbar and some globe.
  const most = Math.max(MIN_SIDE_WIDTH, Math.min(MAX_SIDE_WIDTH, viewportWidth - 320));
  return Math.round(Math.min(most, Math.max(MIN_SIDE_WIDTH, width)));
}

function remembered(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private window: the choice just is not kept */ }
}

export function setupSidePanel(side: HTMLElement): void {
  const root = document.documentElement;
  const setWidth = (width: number) => root.style.setProperty('--side-width', `${clampSideWidth(width, window.innerWidth)}px`);
  const saved = Number(remembered(WIDTH_KEY));
  if (saved > 0) setWidth(saved);

  const grip = document.createElement('div');
  grip.id = 'sideGrip';
  grip.title = 'Drag to change the panel width';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  document.body.append(grip);
  // The strip sits on the panel's left edge and is as tall as the panel.
  new ResizeObserver(() => { grip.style.height = `${side.offsetHeight}px`; }).observe(side);
  grip.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const startX = down.clientX, startWidth = side.getBoundingClientRect().width;
    const move = (e: PointerEvent) => setWidth(startWidth + (startX - e.clientX)); // the panel grows as the edge moves left
    const stop = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', stop);
      grip.removeEventListener('pointercancel', stop);
      remember(WIDTH_KEY, String(Math.round(side.getBoundingClientRect().width)));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  });
  window.addEventListener('resize', () => setWidth(side.getBoundingClientRect().width));

  let folded: string[] = [];
  try { folded = JSON.parse(remembered(FOLDED_KEY) ?? '[]') as string[]; } catch { /* start unfolded */ }
  for (const section of side.querySelectorAll<HTMLElement>('section')) {
    const heading = section.querySelector('h2');
    if (!heading) continue;
    const name = heading.textContent ?? '';
    const body = document.createElement('div');
    body.className = 'sectionBody';
    while (heading.nextSibling) body.append(heading.nextSibling); // moved, not copied: everything inside keeps working
    section.append(body);
    heading.tabIndex = 0;
    heading.setAttribute('role', 'button');
    const fold = (isFolded: boolean) => {
      section.classList.toggle('folded', isFolded);
      heading.setAttribute('aria-expanded', String(!isFolded));
    };
    fold(folded.includes(name));
    const toggle = () => {
      fold(!section.classList.contains('folded'));
      folded = folded.filter((n) => n !== name);
      if (section.classList.contains('folded')) folded.push(name);
      remember(FOLDED_KEY, JSON.stringify(folded));
    };
    heading.addEventListener('click', toggle);
    heading.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }
}
