/**
 * Chess.com Best Move Extension - Content Script
 *
 * Responsibilities:
 * - Detect the chess board on chess.com
 * - Extract the current position as a FEN string
 * - Run Stockfish via a Web Worker to analyze the position
 * - Draw an SVG arrow showing the best move (and optionally top-N moves)
 * - Show evaluation and search depth in a small floating panel
 */

// ---------------------------------------------------------------------------
// Configuration defaults (overridden by popup settings)
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  enabled: true,
  moveTimeMs: 1000,
  multiPv: 1,
  showEval: true,
  showDepth: true,
  arrowColor: "rgba(0, 255, 0, 0.75)",
  secondaryArrowColor: "rgba(255, 215, 0, 0.55)",
  arrowWidth: 6,
};

let config = { ...DEFAULT_CONFIG };

// ---------------------------------------------------------------------------
// Settings storage
// ---------------------------------------------------------------------------
chrome.storage.sync.get(DEFAULT_CONFIG, (items) => {
  config = { ...DEFAULT_CONFIG, ...items };
});

chrome.storage.onChanged.addListener((changes) => {
  for (const key in changes) {
    if (key in DEFAULT_CONFIG) {
      config[key] = changes[key].newValue;
    }
  }
  // Trigger a re-analysis with new settings
  scheduleAnalysis(100);
});

// ---------------------------------------------------------------------------
// Stockfish Worker
// ---------------------------------------------------------------------------
let stockfish = null;
let stockfishReady = false;
let currentFen = null;
let analysisTimer = null;
let lastAnalyzedFen = null;

function initStockfish() {
  if (stockfish) return;

  const scriptUrl = chrome.runtime.getURL("stockfish/stockfish-18-lite-single.js");
  const wasmUrl = chrome.runtime.getURL("stockfish/stockfish-18-lite-single.wasm");

  let workerUrl;
  try {
    // MV3 content scripts sometimes can't create chrome-extension:// workers directly.
    // Using a blob worker that imports the script via importScripts() is more robust.
    const workerScript = `self.importScripts("${scriptUrl}");`;
    const blob = new Blob([workerScript], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    workerUrl = `${blobUrl}#${encodeURIComponent(wasmUrl)}`;
    console.log("[Chess.com Best Move] Using blob worker URL");
  } catch (e) {
    console.warn("[Chess.com Best Move] Blob worker creation failed, falling back to direct URL:", e);
    workerUrl = `${scriptUrl}#${encodeURIComponent(wasmUrl)}`;
  }

  try {
    stockfish = new Worker(workerUrl);
    stockfish.addEventListener("message", onStockfishMessage);
    stockfish.addEventListener("error", (e) => {
      console.error("[Chess.com Best Move] Stockfish worker error:", e);
    });
    sendStockfish("uci");
    console.log("[Chess.com Best Move] Stockfish worker created, waiting for uciok...");
  } catch (e) {
    console.error("[Chess.com Best Move] Failed to create Stockfish worker:", e);
  }
}

function sendStockfish(cmd) {
  if (!stockfish) return;
  try {
    stockfish.postMessage(cmd);
  } catch (e) {
    console.error("[Chess.com Best Move] Failed to send to Stockfish:", e);
  }
}

function onStockfishMessage(event) {
  const line = String(event.data);
  console.log("[Chess.com Best Move] SF:", line);

  if (line === "uciok") {
    sendStockfish("setoption name UCI_ShowWDL value true");
    sendStockfish("isready");
    return;
  }

  if (line === "readyok") {
    stockfishReady = true;
    console.log("[Chess.com Best Move] Stockfish ready.");
    scheduleAnalysis(200);
    return;
  }

  // Capture depth from info lines
  const depth = parseSearchDepthLine(line);
  if (depth) {
    updateDepthDisplay(depth);
  }

  // Capture principal variations (top moves)
  const pv = parsePrincipalVariationLine(line);
  if (pv) {
    cacheCandidateMove(pv);
  }

  // Final bestmove
  if (line.startsWith("bestmove ")) {
    finalizeAnalysis(line);
  }
}

// ---------------------------------------------------------------------------
// Simple UCI protocol parsers (inline to keep the content script self-contained)
// ---------------------------------------------------------------------------
const UCI_MOVE_PATTERN = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

function normalizeUciMove(value) {
  const normalized = value.trim().toLowerCase();
  const match = UCI_MOVE_PATTERN.exec(normalized);
  if (!match) return null;
  const from = match[1];
  const to = match[2];
  const promotion = match[3];
  return promotion ? `${from}${to}${promotion}` : `${from}${to}`;
}

function parseSearchDepthLine(line) {
  if (!line.startsWith("info ")) return null;
  const parts = line.trim().split(/\s+/);
  const idx = parts.indexOf("depth");
  const depth = idx >= 0 ? parseInt(parts[idx + 1] ?? "", 10) : NaN;
  return Number.isFinite(depth) && depth > 0 ? depth : null;
}

function parseEvaluationLine(line) {
  if (!line.startsWith("info ")) return null;
  const parts = line.trim().split(/\s+/);
  const scoreIdx = parts.indexOf("score");
  if (scoreIdx < 0 || !parts[scoreIdx + 1] || !parts[scoreIdx + 2]) return null;
  const value = parseInt(parts[scoreIdx + 2] ?? "", 10);
  if (!Number.isFinite(value)) return null;
  if (parts[scoreIdx + 1] === "cp") return { kind: "centipawn", value };
  if (parts[scoreIdx + 1] === "mate") return { kind: "mate", value };
  return null;
}

function parsePrincipalVariationLine(line) {
  if (!line.startsWith("info ")) return null;
  const parts = line.trim().split(/\s+/);
  const pvIdx = parts.indexOf("pv");
  const pvMove = pvIdx >= 0 ? parts[pvIdx + 1] : undefined;
  const uci = pvMove ? normalizeUciMove(pvMove) : null;
  if (!uci) return null;

  const multipvIdx = parts.indexOf("multipv");
  const parsedRank = parseInt(parts[multipvIdx + 1] ?? "1", 10);
  const rank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;
  const evaluation = parseEvaluationLine(line);
  const searchDepth = parseSearchDepthLine(line);

  return { rank, uci, evaluation, searchDepth };
}

// ---------------------------------------------------------------------------
// Analysis state
// ---------------------------------------------------------------------------
let candidateMoves = [];
let isSearching = false;
let pendingFen = null;

function cacheCandidateMove(move) {
  candidateMoves[move.rank - 1] = move;
}

function finalizeAnalysis(bestmoveLine) {
  isSearching = false;

  const parts = bestmoveLine.trim().split(/\s+/);
  if (parts[0] !== "bestmove" || !parts[1] || parts[1] === "(none)") {
    candidateMoves = [];
  } else {
    const bestUci = normalizeUciMove(parts[1]);
    if (bestUci) {
      const existing = candidateMoves.find((m) => m && m.uci === bestUci);
      if (!existing) {
        candidateMoves[0] = { rank: 1, uci: bestUci };
      }
    }
  }

  drawArrows();
  updateEvalDisplay();

  // If a new position was queued while searching, start analyzing it now
  if (pendingFen) {
    const fen = pendingFen;
    pendingFen = null;
    console.log("[Chess.com Best Move] Starting queued analysis for:", fen);
    startAnalysis(fen);
  }
}

// ---------------------------------------------------------------------------
// FEN extraction from chess.com
// ---------------------------------------------------------------------------
// Chrome content scripts run in an "isolated world" — they cannot read JS
// properties that the page attaches to DOM elements (e.g. wc-chess-board.game).
// To get the real FEN we inject a small script into the page's main world,
// which polls the internal game API and sends the FEN back via CustomEvent.
// ---------------------------------------------------------------------------

let latestFenFromPage = null;
let bridgeInjected = false;

function injectFenExtractor() {
  if (bridgeInjected) return;
  bridgeInjected = true;

  const src = chrome.runtime.getURL("page-bridge.js");
  const script = document.createElement("script");
  script.id = "ccbm-fen-bridge";
  script.src = src;
  script.type = "text/javascript";
  script.onload = () => console.log("[Chess.com Best Move] page-bridge.js loaded successfully.");
  script.onerror = () => console.error("[Chess.com Best Move] Failed to load page-bridge.js!");

  (document.head || document.documentElement).appendChild(script);
  console.log("[Chess.com Best Move] Injecting external FEN bridge script:", src);
}

let lastBridgeFen = null;
let bridgeEventThrottle = null;

window.addEventListener("chesscom-bestmove-fen", (event) => {
  const fen = event.detail;
  if (!fen || fen === lastBridgeFen) return;
  lastBridgeFen = fen;
  latestFenFromPage = fen;
  console.log("[Chess.com Best Move] Received FEN from page bridge:", fen);

  // Throttle: ignore rapid successive events (e.g. from mouse/keyboard interactions)
  if (bridgeEventThrottle) clearTimeout(bridgeEventThrottle);
  bridgeEventThrottle = setTimeout(() => {
    bridgeEventThrottle = null;
    scheduleAnalysis(100);
  }, 150);
});

const PIECE_MAP = {
  wp: "P", wn: "N", wb: "B", wr: "R", wq: "Q", wk: "K",
  bp: "p", bn: "n", bb: "b", br: "r", bq: "q", bk: "k",
};

function getBoardElement() {
  let board = document.querySelector("wc-chess-board");
  if (board) return board;

  board = document.querySelector("chess-board");
  if (board) return board;

  board = document.querySelector("#board-single");
  if (board) return board;

  board = document.querySelector(".board");
  if (board) return board;

  board = document.querySelector("#board-play-area .board");
  if (board) return board;

  return null;
}

function isEmptyBoardFen(fen) {
  if (!fen) return true;
  const placement = fen.split(" ")[0];
  return placement === "8/8/8/8/8/8/8/8";
}

function getFenFromBoard() {
  // 1. Use FEN from injected page script (most reliable for modern chess.com)
  if (latestFenFromPage && !isEmptyBoardFen(latestFenFromPage)) {
    return latestFenFromPage;
  }

  const board = getBoardElement();
  if (!board) return null;

  // 2. Parse from shadow DOM or regular DOM (legacy boards + modern wc-chess-board)
  const root = board.shadowRoot || board;
  let pieces = root.querySelectorAll(".piece");

  // Fallback: if no .piece elements, try to find pieces by other means
  if (pieces.length === 0) {
    // Modern chess.com may render pieces as <img> or <div> with data-square
    pieces = root.querySelectorAll('[data-square]');
    if (pieces.length === 0) {
      // Try looking for any elements that look like pieces (common chess.com patterns)
      pieces = root.querySelectorAll('.chess-piece, [class*="piece"], .piece-3d');
    }
    if (pieces.length === 0) {
      // Try the #board-layout-pieces container
      const layoutPieces = document.querySelector('#board-layout-pieces');
      if (layoutPieces) {
        pieces = layoutPieces.querySelectorAll('.piece, [data-square], [class*="piece"]');
      }
    }
    if (pieces.length === 0) {
      console.warn("[Chess.com Best Move] No piece elements found for DOM FEN extraction.");
      return null;
    }
  }

  const isFlipped =
    board.classList.contains("flipped") ||
    board.classList.contains("orientation-black");

  const squares = new Map();

  for (const piece of pieces) {
    let square = null;
    let pieceChar = null;

    // Method 1: class-based square and piece identification
    for (const cls of piece.classList) {
      if (cls.startsWith("square-")) {
        square = cls.replace("square-", "");
      } else if (cls.startsWith("data-square-")) {
        square = cls.replace("data-square-", "");
      } else if (PIECE_MAP[cls]) {
        pieceChar = PIECE_MAP[cls];
      }
    }

    // Method 2: data-square attribute
    if (!square && piece.hasAttribute("data-square")) {
      square = piece.getAttribute("data-square");
    }

    // Method 3: infer square from DOM position
    if (!square) {
      square = inferSquareFromPosition(piece, board);
    }

    // Method 4: look for piece type in other attributes or nested elements
    if (!pieceChar) {
      // Check for piece type in class names (e.g., "piece wp" or just "wp")
      const classes = Array.from(piece.classList).join(' ');
      for (const [key, val] of Object.entries(PIECE_MAP)) {
        if (classes.includes(key)) {
          pieceChar = val;
          break;
        }
      }
    }

    if (square && pieceChar) {
      squares.set(square, pieceChar);
    }
  }

  return buildFen(squares, isFlipped);
}

function inferSquareFromPosition(piece, board) {
  const boardRect = board.getBoundingClientRect();
  const pieceRect = piece.getBoundingClientRect();
  const squareSize = boardRect.width / 8;

  const fileIndex = Math.floor((pieceRect.left - boardRect.left) / squareSize);
  const rankIndex = Math.floor((pieceRect.top - boardRect.top) / squareSize);

  if (fileIndex < 0 || fileIndex > 7 || rankIndex < 0 || rankIndex > 7) return null;

  const file = String.fromCharCode("a".charCodeAt(0) + fileIndex);
  const rank = String(8 - rankIndex);
  return `${file}${rank}`;
}

function buildFen(squares, isFlipped) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const fileChar = String.fromCharCode("a".charCodeAt(0) + file);
      const square = `${fileChar}${rank}`;
      const piece = squares.get(square);
      if (piece) {
        if (empty > 0) {
          row += empty;
          empty = 0;
        }
        row += piece;
      } else {
        empty++;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }

  const piecePlacement = rows.join("/");
  return `${piecePlacement} w KQkq - 0 1`;
}

// ---------------------------------------------------------------------------
// Analysis orchestration
// ---------------------------------------------------------------------------
function scheduleAnalysis(delayMs = 300) {
  if (analysisTimer) {
    clearTimeout(analysisTimer);
  }
  if (!config.enabled) {
    clearOverlay();
    return;
  }
  analysisTimer = setTimeout(runAnalysis, delayMs);
}

function startAnalysis(fen) {
  if (!stockfishReady || !stockfish) {
    console.log("[Chess.com Best Move] Cannot start analysis, Stockfish not ready.");
    scheduleAnalysis(500);
    return;
  }

  candidateMoves = [];
  lastAnalyzedFen = fen;
  isSearching = true;

  const multiPv = Math.min(Math.max(config.multiPv || 1, 1), 3);
  const moveTime = Math.min(Math.max(config.moveTimeMs || 1000, 100), 30000);

  console.log("[Chess.com Best Move] Starting Stockfish analysis for FEN:", fen);
  sendStockfish("setoption name MultiPV value " + multiPv);
  sendStockfish("isready");
  sendStockfish("position fen " + fen);
  sendStockfish("go movetime " + moveTime);
}

function runAnalysis() {
  if (!config.enabled) {
    clearOverlay();
    return;
  }

  // Ensure the page-world FEN bridge is present whenever we have a board
  if (getBoardElement()) {
    injectFenExtractor();
  }

  const fen = getFenFromBoard();
  if (!fen) {
    console.log("[Chess.com Best Move] No FEN available, skipping analysis.");
    return;
  }

  if (isEmptyBoardFen(fen)) {
    console.log("[Chess.com Best Move] Board appears empty, skipping analysis.");
    return;
  }

  if (fen === lastAnalyzedFen) return;
  currentFen = fen;

  if (!stockfishReady) {
    console.log("[Chess.com Best Move] FEN updated but Stockfish not ready yet, rescheduling...");
    scheduleAnalysis(500);
    return;
  }

  // If a search is already running, queue this FEN and ask Stockfish to stop.
  // We'll start the queued analysis only after receiving the 'bestmove' response.
  if (isSearching) {
    console.log("[Chess.com Best Move] Search in progress, queuing new FEN:", fen);
    pendingFen = fen;
    sendStockfish("stop");
    return;
  }

  startAnalysis(fen);
}

// ---------------------------------------------------------------------------
// DOM Overlay: arrows + eval panel
// ---------------------------------------------------------------------------
let overlayContainer = null;
let evalPanel = null;
let arrowSvg = null;
let depthDisplay = null;

function ensureOverlay() {
  if (overlayContainer) return;

  const board = getBoardElement();
  if (!board) return;

  const rect = board.getBoundingClientRect();
  const computed = getComputedStyle(board);

  overlayContainer = document.createElement("div");
  overlayContainer.id = "chess-com-best-move-overlay";
  overlayContainer.style.position = "absolute";
  overlayContainer.style.left = `${rect.left + window.scrollX}px`;
  overlayContainer.style.top = `${rect.top + window.scrollY}px`;
  overlayContainer.style.width = `${rect.width}px`;
  overlayContainer.style.height = `${rect.height}px`;
  overlayContainer.style.pointerEvents = "none";
  overlayContainer.style.zIndex = "9999";

  // SVG for arrows
  arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("width", "100%");
  arrowSvg.setAttribute("height", "100%");
  arrowSvg.style.position = "absolute";
  arrowSvg.style.top = "0";
  arrowSvg.style.left = "0";
  arrowSvg.style.overflow = "visible";

  // Define arrowhead markers
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrowhead-primary" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="${config.arrowColor}" />
    </marker>
    <marker id="arrowhead-secondary" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="${config.secondaryArrowColor}" />
    </marker>
  `;
  arrowSvg.appendChild(defs);
  overlayContainer.appendChild(arrowSvg);

  // Eval panel
  evalPanel = document.createElement("div");
  evalPanel.id = "chess-com-best-move-eval";
  evalPanel.textContent = "Analyzing...";
  overlayContainer.appendChild(evalPanel);

  // Depth display
  depthDisplay = document.createElement("div");
  depthDisplay.id = "chess-com-best-move-depth";
  depthDisplay.textContent = "";
  overlayContainer.appendChild(depthDisplay);

  document.body.appendChild(overlayContainer);
}

function updateOverlayPosition() {
  const board = getBoardElement();
  if (!board || !overlayContainer) return;

  const rect = board.getBoundingClientRect();
  overlayContainer.style.left = `${rect.left + window.scrollX}px`;
  overlayContainer.style.top = `${rect.top + window.scrollY}px`;
  overlayContainer.style.width = `${rect.width}px`;
  overlayContainer.style.height = `${rect.height}px`;
}

function clearOverlay() {
  if (overlayContainer) {
    overlayContainer.remove();
    overlayContainer = null;
    arrowSvg = null;
    evalPanel = null;
    depthDisplay = null;
  }
}

function updateDepthDisplay(depth) {
  if (!config.showDepth || !depthDisplay) return;
  depthDisplay.textContent = `Depth ${depth}`;
}

function updateEvalDisplay() {
  if (!evalPanel) return;

  const best = candidateMoves.find((m) => m && m.rank === 1);
  if (!best || !best.evaluation) {
    evalPanel.textContent = "Analyzing...";
    return;
  }

  const ev = best.evaluation;
  let text = "";
  if (ev.kind === "mate") {
    text = `M${ev.value > 0 ? "" : "-"}${Math.abs(ev.value)}`;
  } else {
    const pawns = (ev.value / 100).toFixed(2);
    text = `${pawns > 0 ? "+" : ""}${pawns}`;
  }

  evalPanel.textContent = text;
}

function drawArrows() {
  if (!config.enabled) {
    clearOverlay();
    return;
  }

  ensureOverlay();
  updateOverlayPosition();

  if (!arrowSvg) return;

  // Clear existing arrows
  while (arrowSvg.lastChild && arrowSvg.lastChild.tagName !== "defs") {
    arrowSvg.removeChild(arrowSvg.lastChild);
  }

  const board = getBoardElement();
  if (!board) return;

  const movesToDraw = candidateMoves
    .filter((m) => m && m.rank <= config.multiPv)
    .slice(0, 3);

  console.log("[Chess.com Best Move] Drawing arrows:", movesToDraw.map(m => m?.uci));

  const rect = board.getBoundingClientRect();
  const squareSize = rect.width / 8;

  // Detect flipped orientation
  const isFlipped = board.classList.contains("flipped") || board.classList.contains("orientation-black");

  for (const move of movesToDraw) {
    if (!move || !move.uci) continue;
    const from = move.uci.slice(0, 2);
    const to = move.uci.slice(2, 4);

    const fromCoord = getSquareCenter(from, squareSize, isFlipped, rect);
    const toCoord = getSquareCenter(to, squareSize, isFlipped, rect);

    if (!fromCoord || !toCoord) continue;

    const isPrimary = move.rank === 1;
    const color = isPrimary ? config.arrowColor : config.secondaryArrowColor;
    const marker = isPrimary ? "url(#arrowhead-primary)" : "url(#arrowhead-secondary)";
    const width = isPrimary ? config.arrowWidth : Math.max(2, config.arrowWidth - 2);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", fromCoord.x);
    line.setAttribute("y1", fromCoord.y);
    line.setAttribute("x2", toCoord.x);
    line.setAttribute("y2", toCoord.y);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", width);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("marker-end", marker);

    arrowSvg.appendChild(line);

    // If this is a promotion move, draw a small circle on the target square
    if (move.uci.length === 5) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", toCoord.x);
      circle.setAttribute("cy", toCoord.y);
      circle.setAttribute("r", width * 1.5);
      circle.setAttribute("fill", color);
      arrowSvg.appendChild(circle);
    }
  }
}

function getSquareCenter(square, squareSize, isFlipped, boardRect) {
  const file = square.charCodeAt(0) - "a".charCodeAt(0); // 0-7
  const rank = parseInt(square[1], 10); // 1-8

  if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;

  // In normal orientation, a1 is bottom-left.
  // In flipped orientation, a1 is top-right.
  let x, y;
  if (isFlipped) {
    x = (7 - file + 0.5) * squareSize;
    y = (rank - 1 + 0.5) * squareSize;
  } else {
    x = (file + 0.5) * squareSize;
    y = (8 - rank + 0.5) * squareSize;
  }

  return { x, y };
}

// ---------------------------------------------------------------------------
// Board change detection
// ---------------------------------------------------------------------------
let boardObserver = null;
let lastObservedBoard = null;
let spaCheckInterval = null;

function attachBoardObserver(board) {
  if (boardObserver) {
    boardObserver.disconnect();
    boardObserver = null;
  }
  lastObservedBoard = board;

  boardObserver = new MutationObserver(() => {
    lastAnalyzedFen = null; // force re-analysis
    scheduleAnalysis(150);
  });

  const target = board.shadowRoot || board;
  boardObserver.observe(target, { childList: true, subtree: true, attributes: true });
}

function observeBoard() {
  if (spaCheckInterval) return; // already running

  spaCheckInterval = setInterval(() => {
    const currentBoard = getBoardElement();

    if (!currentBoard) {
      if (overlayContainer) {
        clearOverlay();
      }
      if (boardObserver) {
        boardObserver.disconnect();
        boardObserver = null;
        lastObservedBoard = null;
      }
      return;
    }

    if (currentBoard !== lastObservedBoard) {
      attachBoardObserver(currentBoard);
      lastAnalyzedFen = null;
      injectFenExtractor(); // inject bridge into page world to read internal API
    }

    if (config.enabled) {
      updateOverlayPosition();
      scheduleAnalysis(400);
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
function start() {
  initStockfish();
  observeBoard();
}

// Start immediately. On chess.com SPA, the board may appear after navigation.
// observeBoard() runs indefinitely and detects the board when it shows up.
start();
