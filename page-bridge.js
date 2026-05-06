// page-bridge.js - Injected into chess.com page world to read internal game API
// This runs in the page's JavaScript world (not the content script's isolated world),
// so it can access chess.com's internal properties on DOM elements.

(function() {
  'use strict';

  const EVENT_NAME = 'chesscom-bestmove-fen';
  let lastFen = '';
  let intervalId = null;

  function getBoard() {
    return document.querySelector('wc-chess-board') || document.querySelector('chess-board');
  }

  function getFen() {
    const board = getBoard();
    if (!board || !board.game) return null;

    // Try different API shapes that chess.com might use
    if (typeof board.game.getFEN === 'function') {
      try { return board.game.getFEN(); } catch(e) { /* ignore */ }
    }
    if (typeof board.game.getFen === 'function') {
      try { return board.game.getFen(); } catch(e) { /* ignore */ }
    }
    if (typeof board.game.fen === 'function') {
      try { return board.game.fen(); } catch(e) { /* ignore */ }
    }
    if (board.game.fen && typeof board.game.fen === 'string') {
      return board.game.fen;
    }
    return null;
  }

  function getTurn() {
    const board = getBoard();
    if (!board || !board.game) return 'w';
    if (typeof board.game.turn === 'function') {
      try { return board.game.turn() === 'b' ? 'b' : 'w'; } catch(e) { return 'w'; }
    }
    return 'w';
  }

  function reportFen() {
    const fen = getFen();
    if (!fen || fen === lastFen) return;
    lastFen = fen;

    // Ensure it's a full FEN (6 space-separated fields)
    const parts = fen.split(' ');
    const fullFen = parts.length >= 6 ? fen : (fen + ' ' + getTurn() + ' KQkq - 0 1');

    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: fullFen,
      bubbles: false,
      cancelable: false
    }));
  }

  // Poll periodically (moderate frequency to avoid flooding the content script)
  intervalId = setInterval(reportFen, 500);

  // Also report on user interactions that might trigger moves
  document.addEventListener('mouseup', reportFen, true);
  document.addEventListener('touchend', reportFen, true);
  document.addEventListener('keydown', reportFen, true);

  // Report immediately on start
  reportFen();

  // Expose a way for the content script to force a report
  window.__chesscomBestMoveBridge = { reportFen };
})();
