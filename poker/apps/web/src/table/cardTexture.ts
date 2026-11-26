/**
 * Card textures (W6): canvas-drawn faces and back, cached per card. They return plain canvases; `Cards.tsx`
 * wraps them in `THREE.CanvasTexture`. Corners outside the rounded rectangle are transparent, so the card
 * reads as rounded with an alpha test. Without a 2D context (jsdom) the canvas is returned blank.
 */
import { rankOf, suitOf, type Card } from '@poker/engine';

export const CARD_TEXTURE_WIDTH = 256;
export const CARD_TEXTURE_HEIGHT = 356;

const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
/** Indexed by `suitOf`: clubs, diamonds, hearts, spades. */
const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'];
const TWO_COLOUR = ['#1b1d1c', '#c4473f', '#c4473f', '#1b1d1c'];
const FOUR_COLOUR = ['#1f8a4c', '#2a62c9', '#c4473f', '#1b1d1c'];

/** App palette (see the CSS tokens: --felt-deep, --felt, --gold). */
const BACK_BASE = '#134a31';
const BACK_MID = '#1f6b47';
const BACK_ACCENT = '#d9b45a';

const RADIUS = 22;

const faceCache = new Map<string, HTMLCanvasElement>();
let backCache: HTMLCanvasElement | null = null;

function newCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_TEXTURE_WIDTH;
  canvas.height = CARD_TEXTURE_HEIGHT;
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Suit colour of a card, two- or four-colour deck. */
export function suitColour(card: Card, fourColour = false): string {
  return (fourColour ? FOUR_COLOUR : TWO_COLOUR)[suitOf(card)]!;
}

/** Suit symbol of a card (♣ ♦ ♥ ♠). */
export function suitSymbol(card: Card): string {
  return SUIT_SYMBOLS[suitOf(card)]!;
}

/** Corner label of a card's rank ('10' for a ten). */
export function rankLabel(card: Card): string {
  return RANK_LABELS[rankOf(card)]!;
}

export function cardFaceTexture(card: Card, fourColour = false): HTMLCanvasElement {
  const key = `${card}:${fourColour ? 4 : 2}`;
  const cached = faceCache.get(key);
  if (cached) return cached;
  const canvas = newCanvas();
  faceCache.set(key, canvas);
  const ctx = context(canvas);
  if (!ctx) return canvas;

  const W = CARD_TEXTURE_WIDTH;
  const H = CARD_TEXTURE_HEIGHT;
  const colour = suitColour(card, fourColour);
  const rank = rankLabel(card);
  const suit = SUIT_SYMBOLS[suitOf(card)]!;

  ctx.clearRect(0, 0, W, H);
  roundedRect(ctx, 2, 2, W - 4, H - 4, RADIUS);
  ctx.fillStyle = '#fbfaf6';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#c9cdc9';
  ctx.stroke();

  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = (px: number) => `bold ${px}px "Helvetica Neue", Arial, sans-serif`;

  // Large corner index (top left) so the card reads at a distance, even when a neighbour overlaps its right
  // side, and a big pip in the lower right.
  ctx.font = font(rank.length > 1 ? 96 : 116);
  ctx.fillText(rank, 64, 70);
  ctx.font = font(84);
  ctx.fillText(suit, 64, 160);
  ctx.font = font(170);
  ctx.fillText(suit, W - 82, H - 92);
  return canvas;
}

export function cardBackTexture(): HTMLCanvasElement {
  if (backCache) return backCache;
  const canvas = newCanvas();
  backCache = canvas;
  const ctx = context(canvas);
  if (!ctx) return canvas;

  const W = CARD_TEXTURE_WIDTH;
  const H = CARD_TEXTURE_HEIGHT;
  ctx.clearRect(0, 0, W, H);
  roundedRect(ctx, 2, 2, W - 4, H - 4, RADIUS);
  ctx.fillStyle = '#fbfaf6';
  ctx.fill();

  const m = 16;
  roundedRect(ctx, m, m, W - 2 * m, H - 2 * m, RADIUS - 8);
  ctx.fillStyle = BACK_BASE;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // Diamond lattice.
  const step = 28;
  ctx.lineWidth = 2;
  ctx.strokeStyle = BACK_MID;
  for (let d = -H; d < W + H; d += step) {
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d + H, H);
    ctx.moveTo(d, H);
    ctx.lineTo(d + H, 0);
    ctx.stroke();
  }
  // Gold inner frame and centre medallion.
  ctx.lineWidth = 4;
  ctx.strokeStyle = BACK_ACCENT;
  roundedRect(ctx, m + 12, m + 12, W - 2 * m - 24, H - 2 * m - 24, RADIUS - 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W / 2, H / 2 - 52);
  ctx.lineTo(W / 2 + 38, H / 2);
  ctx.lineTo(W / 2, H / 2 + 52);
  ctx.lineTo(W / 2 - 38, H / 2);
  ctx.closePath();
  ctx.fillStyle = BACK_BASE;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = BACK_ACCENT;
  ctx.font = 'bold 44px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('♠', W / 2, H / 2 + 2);
  ctx.restore();
  return canvas;
}
