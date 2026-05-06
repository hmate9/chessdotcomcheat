const DEFAULTS = {
  enabled: true,
  moveTimeMs: 1000,
  multiPv: 1,
  showEval: true,
  showDepth: true,
};

function $(id) {
  return document.getElementById(id);
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    $("enabled").checked = items.enabled;
    $("moveTime").value = items.moveTimeMs;
    $("moveTimeValue").textContent = `${items.moveTimeMs} ms`;
    $("multiPv").value = items.multiPv;
    $("multiPvValue").textContent = `${items.multiPv}`;
    $("showEval").checked = items.showEval;
    $("showDepth").checked = items.showDepth;
  });
}

function saveSettings() {
  chrome.storage.sync.set({
    enabled: $("enabled").checked,
    moveTimeMs: parseInt($("moveTime").value, 10),
    multiPv: parseInt($("multiPv").value, 10),
    showEval: $("showEval").checked,
    showDepth: $("showDepth").checked,
  });
}

$("enabled").addEventListener("change", saveSettings);

$("moveTime").addEventListener("input", () => {
  $("moveTimeValue").textContent = `${$("moveTime").value} ms`;
  saveSettings();
});

$("multiPv").addEventListener("input", () => {
  $("multiPvValue").textContent = $("multiPv").value;
  saveSettings();
});

$("showEval").addEventListener("change", saveSettings);
$("showDepth").addEventListener("change", saveSettings);

$("resetBtn").addEventListener("click", () => {
  chrome.storage.sync.set(DEFAULTS, loadSettings);
});

loadSettings();
