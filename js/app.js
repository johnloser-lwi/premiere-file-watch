"use strict";

// ---------------------------------------------------------------------------
// CEP bridge
// ---------------------------------------------------------------------------

const cs = new CSInterface();

/** Wrap cs.evalScript in a Promise so we can use async/await. */
function evalScript(script) {
  return new Promise((resolve) => {
    cs.evalScript(script, resolve);
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "filewatch.mappings";

/**
 * Premiere Pro label color indices matched to the actual colors shown in the
 * Premiere Pro UI label picker. Index 0 = no label (clear).
 */
const LABEL_COLORS = [
  { index: 0,  name: "Violet",     hex: "#6b3fa0" },
  { index: 1,  name: "Iris",       hex: "#3878b0" },
  { index: 2,  name: "Caribbean",  hex: "#5c8020" },
  { index: 3,  name: "Lavender",   hex: "#c838a0" },
  { index: 4,  name: "Cerulean",   hex: "#38a090" },
  { index: 5,  name: "Forest",     hex: "#888020" },
  { index: 6,  name: "Rose",       hex: "#b83030" },
  { index: 7,  name: "Mango",      hex: "#c86020" },
  { index: 8,  name: "Purple",     hex: "#8030c0" },
  { index: 9,  name: "Blue",       hex: "#3040b8" },
  { index: 10, name: "Teal",       hex: "#288878" },
  { index: 11, name: "Magenta",    hex: "#c02880" },
  { index: 12, name: "Tan",        hex: "#988048" },
  { index: 13, name: "Green",      hex: "#389830" },
  { index: 14, name: "Brown",      hex: "#885020" },
  { index: 15, name: "Yellow",     hex: "#a89020" },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Array<{ binPath: string, drivePath: string, labelColor: number }>} */
let mappings = [];
let watchTimer = null;
let isSyncing = false;

// Active popover reference — only one open at a time
let activePopover = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusEl     = document.getElementById("status");
const tableBody    = document.getElementById("table-body");
const chkAll       = document.getElementById("chk-all");
const btnAdd       = document.getElementById("btn-add");
const btnRemove    = document.getElementById("btn-remove");
const btnImportCSV = document.getElementById("btn-import-csv");
const btnExportCSV = document.getElementById("btn-export-csv");
const btnSync      = document.getElementById("btn-sync");
const chkForceSync = document.getElementById("chk-force-sync");
const toggleWatch  = document.getElementById("toggle-watch");
const intervalSel  = document.getElementById("interval-sel");
const logEl        = document.getElementById("log");
const btnClearLog  = document.getElementById("btn-clear-log");

// ---------------------------------------------------------------------------
// Logging & status
// ---------------------------------------------------------------------------

function log(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry${type !== "info" ? ` log-${type}` : ""}`;
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  entry.textContent = `[${ts}] ${msg}`;
  logEl.insertBefore(entry, logEl.firstChild);
}

function setStatus(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveMappings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
  } catch (e) {
    log(`Failed to save mappings: ${e.message}`, "error");
  }
}

function loadMappings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    mappings = raw ? JSON.parse(raw) : [];
    // Ensure labelColor field exists on older saved rows
    mappings.forEach((m) => {
      if (m.labelColor === undefined) m.labelColor = -1;
      if (m.lastSyncTime === undefined) m.lastSyncTime = 0;
      if (m.enabled === undefined) m.enabled = true;
    });
  } catch (e) {
    mappings = [];
    log(`Failed to load saved mappings: ${e.message}`, "warn");
  }
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function mappingsToCSV(rows) {
  const escape = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return [
    "binPath,drivePath,labelColor",
    ...rows.map((r) => `${escape(r.binPath)},${escape(r.drivePath)},${r.labelColor ?? 0}`)
  ].join("\r\n");
}

function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let field = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 2; }
          else { i++; break; }
        } else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      else { fields.push(line.slice(i, end)); i = end + 1; }
    }
  }
  return fields;
}

function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);
    if (fields.length >= 2) {
      rows.push({
        binPath: fields[0],
        drivePath: fields[1],
        labelColor: fields[2] ? parseInt(fields[2], 10) || 0 : 0
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Color popover
// ---------------------------------------------------------------------------

function closeActivePopover() {
  if (activePopover) {
    activePopover.classList.add("hidden");
    activePopover = null;
  }
}

/**
 * Build and attach a color-picker popover to a swatch element.
 * @param {HTMLElement} swatch  the colored square button
 * @param {number} rowIndex
 */
function attachColorPopover(swatch, rowIndex) {
  const popover = document.createElement("div");
  popover.className = "color-popover hidden";

  LABEL_COLORS.forEach((color) => {
    const opt = document.createElement("div");
    opt.className = "color-option";
    opt.style.background = color.hex;
    opt.title = color.name;
    if (color.index === mappings[rowIndex].labelColor) opt.classList.add("active");

    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      mappings[rowIndex].labelColor = color.index;
      mappings[rowIndex].lastSyncTime = 0;   // force full re-sync so all items get relabeled
      saveMappings();
      // Update swatch appearance
      swatch.style.background = color.hex;
      swatch.title = color.name;
      // Update active state in popover
      popover.querySelectorAll(".color-option").forEach((o) => o.classList.remove("active"));
      opt.classList.add("active");
      closeActivePopover();
    });

    popover.appendChild(opt);
  });

  document.body.appendChild(popover);

  swatch.addEventListener("click", (e) => {
    e.stopPropagation();
    if (activePopover === popover) {
      closeActivePopover();
      return;
    }
    closeActivePopover();

    // Make visible offscreen first to measure its size
    popover.style.visibility = "hidden";
    popover.classList.remove("hidden");

    const rect = swatch.getBoundingClientRect();
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer below, flip above if it would clip the bottom
    const top = rect.bottom + 4 + ph > vh ? rect.top - ph - 4 : rect.bottom + 4;
    // Prefer left-aligned to swatch, nudge left if it clips the right edge
    const left = Math.min(rect.left, vw - pw - 4);

    popover.style.top = `${top}px`;
    popover.style.left = `${Math.max(4, left)}px`;
    popover.style.visibility = "";
    activePopover = popover;
  });

  return popover;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTable() {
  // Remove any orphaned popovers from previous render
  document.querySelectorAll(".color-popover").forEach((p) => p.remove());
  activePopover = null;

  tableBody.innerHTML = "";
  mappings.forEach((mapping, i) => {
    const tr = document.createElement("tr");

    // Checkbox
    const tdChk = document.createElement("td");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.addEventListener("change", () => tr.classList.toggle("selected", chk.checked));
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    // Bin path (editable)
    const tdBin = document.createElement("td");
    const inpBin = document.createElement("input");
    inpBin.type = "text";
    inpBin.className = "cell-input inp-bin";
    inpBin.value = mapping.binPath;
    inpBin.placeholder = "e.g. Footage/Camera A";
    inpBin.addEventListener("change", () => { mappings[i].binPath = inpBin.value.trim(); saveMappings(); });
    tdBin.appendChild(inpBin);
    tr.appendChild(tdBin);

    // Drive path (editable — supports relative paths like ./Footage)
    const tdDrive = document.createElement("td");
    const inpDrive = document.createElement("input");
    inpDrive.type = "text";
    inpDrive.className = "cell-input inp-drive";
    inpDrive.value = mapping.drivePath;
    inpDrive.placeholder = "Absolute or ./relative";
    inpDrive.title = "Absolute path or relative to the .prproj file (e.g. ./Footage)";
    const updateDriveStyle = (val) => {
      const isRelative = val && !val.startsWith("/") && !(val[1] === ":" && val[2] === "/");
      inpDrive.style.color = isRelative ? "#6bff8a" : "";
    };
    updateDriveStyle(mapping.drivePath);
    inpDrive.addEventListener("change", () => {
      const v = inpDrive.value.trim().replace(/\\/g, '/');
      inpDrive.value = v;
      mappings[i].drivePath = v;
      updateDriveStyle(v);
      saveMappings();
    });
    tdDrive.appendChild(inpDrive);
    tr.appendChild(tdDrive);

    // Label color swatch
    const tdColor = document.createElement("td");
    tdColor.className = "td-color";
    const colorDef = LABEL_COLORS.find((c) => c.index === (mapping.labelColor ?? 0)) || LABEL_COLORS[0];
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";
    swatch.style.background = colorDef.hex;
    swatch.title = colorDef.name;
    attachColorPopover(swatch, i);
    tdColor.appendChild(swatch);
    tr.appendChild(tdColor);

    // Active toggle
    const tdActive = document.createElement("td");
    tdActive.className = "td-active";
    const chkActive = document.createElement("input");
    chkActive.type = "checkbox";
    chkActive.title = "Enable/disable this mapping";
    chkActive.checked = mapping.enabled !== false;
    chkActive.addEventListener("change", () => {
      mappings[i].enabled = chkActive.checked;
      tr.classList.toggle("row-disabled", !chkActive.checked);
      saveMappings();
    });
    tr.classList.toggle("row-disabled", !chkActive.checked);
    tdActive.appendChild(chkActive);
    tr.appendChild(tdActive);

    // Browse button
    const tdBrowse = document.createElement("td");
    const btnBrowse = document.createElement("button");
    btnBrowse.type = "button";
    btnBrowse.className = "btn-browse";
    btnBrowse.textContent = "Browse…";
    btnBrowse.addEventListener("click", async () => {
      try {
        const path = await evalScript("browseFolder()");
        if (!path || path === "null" || path === "undefined") return;
        mappings[i].drivePath = path;
        inpDrive.value = path;
        updateDriveStyle(path);
        saveMappings();
        const note = path.startsWith("./") ? " (relative to project)" : "";
        log(`Drive path set: ${path}${note}`);
      } catch (e) {
        log(`Browse error: ${e.message}`, "error");
      }
    });
    tdBrowse.appendChild(btnBrowse);
    tr.appendChild(tdBrowse);

    tableBody.appendChild(tr);
  });

  chkAll.checked = false;
  chkAll.indeterminate = false;
}

// Close popover when clicking elsewhere
document.addEventListener("click", closeActivePopover);

// ---------------------------------------------------------------------------
// Add / Remove rows
// ---------------------------------------------------------------------------

function addRow() {
  mappings.push({ binPath: "", drivePath: "", labelColor: -1 });
  saveMappings();
  renderTable();
  const rows = tableBody.querySelectorAll("tr");
  const lastRow = rows[rows.length - 1];
  if (lastRow) lastRow.querySelector(".inp-bin")?.focus();
}

function removeSelected() {
  const rows = tableBody.querySelectorAll("tr");
  const toRemove = new Set();
  rows.forEach((tr, idx) => {
    const chk = tr.querySelector('input[type="checkbox"]');
    if (chk?.checked) toRemove.add(idx);
  });
  if (toRemove.size === 0) { log("No rows selected.", "warn"); return; }
  mappings = mappings.filter((_, idx) => !toRemove.has(idx));
  saveMappings();
  renderTable();
  log(`Removed ${toRemove.size} mapping(s).`);
}

// ---------------------------------------------------------------------------
// CSV import / export (via CEP file dialog)
// ---------------------------------------------------------------------------

async function exportCSV() {
  try {
    const path = await evalScript(
      "var f = File.saveDialog('Export mappings CSV', '*.csv'); f ? f.fsName : ''"
    );
    if (!path || path === "null") return;
    const content = mappingsToCSV(mappings);
    const escaped = content.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    await evalScript(
      `var f = new File(${JSON.stringify(path)}); f.open('w'); f.write("${escaped}"); f.close(); "ok"`
    );
    log("Mappings exported to CSV.", "success");
  } catch (e) {
    log(`CSV export error: ${e.message}`, "error");
  }
}

async function importCSV() {
  try {
    const path = await evalScript(
      "var f = File.openDialog('Import mappings CSV', '*.csv'); f ? f.fsName : ''"
    );
    if (!path || path === "null") return;
    const content = await evalScript(
      `var f = new File(${JSON.stringify(path)}); f.open('r'); var s = f.read(); f.close(); s`
    );
    if (!content) return;
    const imported = parseCSV(content);
    mappings = imported;
    saveMappings();
    renderTable();
    log(`Imported ${imported.length} mapping(s) from CSV.`, "success");
  } catch (e) {
    log(`CSV import error: ${e.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function syncMapping(mapping) {
  if (!mapping.binPath.trim()) {
    log("Skipping row with empty bin path.", "warn");
    return;
  }
  if (!mapping.drivePath.trim()) {
    log(`No drive path for bin "${mapping.binPath}" — skipping.`, "warn");
    return;
  }

  const labelColor = mapping.labelColor ?? 0;
  const lastSyncEpoch = chkForceSync.checked ? 0 : (mapping.lastSyncTime ?? 0);
  const colorName = LABEL_COLORS.find((c) => c.index === labelColor)?.name;
  const labelNote = labelColor > 0 ? ` [label: ${colorName}]` : "";

  const queue = [{ binPath: mapping.binPath, fsPath: mapping.drivePath }];
  let totalImported = 0, totalSkipped = 0, totalFailed = 0, unchangedCount = 0;

  while (queue.length > 0) {
    const { binPath, fsPath } = queue.shift();

    const script = `syncFolderStep(${JSON.stringify(binPath)}, ${JSON.stringify(fsPath)}, ${labelColor}, ${lastSyncEpoch})`;
    const raw = await evalScript(script);
    let result;
    try { result = JSON.parse(raw); } catch (_) { result = { error: raw }; }

    if (result.error) {
      log(`  Error in "${binPath}": ${result.error}`, "warn");
    } else {
      totalImported += result.imported;
      totalSkipped  += result.skipped;
      totalFailed   += result.failed || 0;
      if (!result.changed) { unchangedCount++; }
      (result.warnings || []).forEach((w) => log(`  Warning: ${w}`, "warn"));
      for (const sub of result.subfolders) queue.push(sub);
    }

  }

  mapping.lastSyncTime = Date.now();
  saveMappings();

  const failedNote    = totalFailed    > 0 ? `, ${totalFailed} failed`       : "";
  const unchangedNote = unchangedCount > 0 ? `, ${unchangedCount} unchanged` : "";
  log(`"${mapping.binPath}": imported ${totalImported}, skipped ${totalSkipped}${failedNote}${unchangedNote}${labelNote}.`, totalFailed > 0 ? "warn" : "success");
}

async function syncAll() {
  if (isSyncing) { log("Sync already in progress.", "warn"); return; }

  isSyncing = true;
  btnSync.disabled = true;
  setStatus("Syncing…", "running");

  let errors = 0;
  for (const mapping of mappings) {
    if (mapping.enabled === false) continue;
    try {
      await syncMapping(mapping);
    } catch (e) {
      log(`Error syncing "${mapping.binPath}": ${e.message}`, "error");
      errors++;
    }
  }

  isSyncing = false;
  btnSync.disabled = false;
  setStatus(errors === 0 ? "Sync complete" : `Sync done with ${errors} error(s)`, errors === 0 ? "success" : "error");
}

// ---------------------------------------------------------------------------
// Auto-watch
// ---------------------------------------------------------------------------

function startWatch() {
  const ms = parseInt(intervalSel.value, 10);
  watchTimer = setInterval(syncAll, ms);
  log(`Auto-watch started (every ${intervalSel.options[intervalSel.selectedIndex].text}).`);
}

function stopWatch() {
  if (watchTimer !== null) { clearInterval(watchTimer); watchTimer = null; log("Auto-watch stopped."); }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

btnAdd.addEventListener("click", addRow);
btnRemove.addEventListener("click", removeSelected);
btnExportCSV.addEventListener("click", exportCSV);
btnImportCSV.addEventListener("click", importCSV);
btnSync.addEventListener("click", syncAll);
btnClearLog.addEventListener("click", () => { logEl.innerHTML = ""; });

chkAll.addEventListener("change", () => {
  tableBody.querySelectorAll("tr").forEach((tr) => {
    const chk = tr.querySelector('input[type="checkbox"]');
    if (chk) { chk.checked = chkAll.checked; tr.classList.toggle("selected", chkAll.checked); }
  });
});

toggleWatch.addEventListener("change", () => {
  intervalSel.disabled = !toggleWatch.checked;
  toggleWatch.checked ? startWatch() : stopWatch();
});

intervalSel.addEventListener("change", () => {
  if (toggleWatch.checked) { stopWatch(); startWatch(); }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadMappings();
renderTable();
log("Plugin ready.");
setStatus("Ready");
