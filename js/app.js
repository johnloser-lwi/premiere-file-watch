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

const STORAGE_KEY  = "filewatch.mappings";
const FILTER_KEY   = "filewatch.ignorePatterns";
const BATCH_SIZE   = 10;

const LABEL_COLORS = [
  { name: "Violet",     hex: "#3E0AAE" },
  { name: "Iris",       hex: "#004B67" },
  { name: "Caribbean",  hex: "#2A5507" },
  { name: "Lavender",   hex: "#751187" },
  { name: "Cerulean",   hex: "#05555B" },
  { name: "Forest",     hex: "#3D4A00" },
  { name: "Rose",       hex: "#8C0235" },
  { name: "Mango",      hex: "#893A04" },
  { name: "Purple",     hex: "#6100B7" },
  { name: "Blue",       hex: "#122D9A" },
  { name: "Teal",       hex: "#014E45" },
  { name: "Magenta",    hex: "#840D58" },
  { name: "Tan",        hex: "#6F5A45" },
  { name: "Green",      hex: "#0D5D27" },
  { name: "Brown",      hex: "#5D3B06" },
  { name: "Yellow",     hex: "#6F6619" },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Array<{ binPath: string, drivePath: string, enabled: boolean }>} */
let mappings = [];
/** @type {string[]} */
let ignorePatterns = [];
let watchTimer = null;
let isSyncing = false;
let showingFilters = false;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusEl       = document.getElementById("status");
const tableBody      = document.getElementById("table-body");
const tableContainer = document.getElementById("table-container");
const filtersPanel   = document.getElementById("filters-panel");
const filterList     = document.getElementById("filter-list");
const filterInput    = document.getElementById("filter-input");
const chkAll         = document.getElementById("chk-all");
const btnAdd         = document.getElementById("btn-add");
const btnRemove      = document.getElementById("btn-remove");
const btnImportCSV   = document.getElementById("btn-import-csv");
const btnExportCSV   = document.getElementById("btn-export-csv");
const btnFilters     = document.getElementById("btn-filters");
const btnAddFilter   = document.getElementById("btn-add-filter");
const btnSync        = document.getElementById("btn-sync");
const toggleWatch    = document.getElementById("toggle-watch");
const intervalSel    = document.getElementById("interval-sel");
const logEl          = document.getElementById("log");
const btnClearLog    = document.getElementById("btn-clear-log");

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
  while (logEl.childElementCount > 500) {
    logEl.removeChild(logEl.lastChild);
  }
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
    mappings.forEach((m) => {
      if (m.enabled === undefined) m.enabled = true;
      if (m.label === undefined) m.label = 0;
    });
  } catch (e) {
    mappings = [];
    log(`Failed to load saved mappings: ${e.message}`, "warn");
  }
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(ignorePatterns));
  } catch (e) {
    log(`Failed to save filters: ${e.message}`, "error");
  }
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    ignorePatterns = raw ? JSON.parse(raw) : [];
  } catch (e) {
    ignorePatterns = [];
  }
}

// ---------------------------------------------------------------------------
// Filter panel rendering
// ---------------------------------------------------------------------------

function renderFilterList() {
  filterList.innerHTML = "";
  if (ignorePatterns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "filter-empty";
    empty.textContent = "No patterns — all files and folders will be imported.";
    filterList.appendChild(empty);
    return;
  }
  ignorePatterns.forEach((pattern, i) => {
    const row = document.createElement("div");
    row.className = "filter-row";

    const patternEl = document.createElement("span");
    patternEl.className = "filter-pattern";
    patternEl.textContent = pattern;

    let isValid = true;
    try { new RegExp(pattern); } catch (_) { isValid = false; }
    if (!isValid) patternEl.classList.add("filter-invalid");

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-filter-remove";
    btnDel.textContent = "×";
    btnDel.title = "Remove pattern";
    btnDel.addEventListener("click", () => {
      ignorePatterns.splice(i, 1);
      saveFilters();
      renderFilterList();
    });

    row.appendChild(patternEl);
    row.appendChild(btnDel);
    filterList.appendChild(row);
  });
}

function addFilterPattern() {
  const val = filterInput.value.trim();
  if (!val) return;
  try { new RegExp(val); } catch (_) {
    log(`Invalid regex: ${val}`, "error");
    return;
  }
  if (!ignorePatterns.includes(val)) {
    ignorePatterns.push(val);
    saveFilters();
    renderFilterList();
  }
  filterInput.value = "";
}

function toggleFiltersView() {
  showingFilters = !showingFilters;
  filtersPanel.classList.toggle("hidden", !showingFilters);
  tableContainer.classList.toggle("hidden", showingFilters);
  btnFilters.classList.toggle("active", showingFilters);
  btnAdd.disabled    = showingFilters;
  btnRemove.disabled = showingFilters;
  if (showingFilters) renderFilterList();
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function mappingsToCSV(rows) {
  const escape = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return [
    "binPath,drivePath,label",
    ...rows.map((r) => `${escape(r.binPath)},${escape(r.drivePath)},${r.label ?? 0}`)
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
      rows.push({ binPath: fields[0], drivePath: fields[1], label: fields[2] !== undefined ? parseInt(fields[2], 10) || 0 : 0 });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Color label popover
// ---------------------------------------------------------------------------

let activeSwatchIndex = -1;

const colorPopoverEl = document.createElement("div");
colorPopoverEl.className = "color-popover hidden";
for (let ci = 0; ci < LABEL_COLORS.length; ci++) {
  const opt = document.createElement("div");
  opt.className = "color-option";
  opt.style.backgroundColor = LABEL_COLORS[ci].hex;
  opt.dataset.labelIndex = ci;
  opt.title = LABEL_COLORS[ci].name;
  colorPopoverEl.appendChild(opt);
}
document.body.appendChild(colorPopoverEl);

colorPopoverEl.addEventListener("click", (e) => {
  const opt = e.target.closest(".color-option");
  if (!opt) return;
  const idx = parseInt(opt.dataset.labelIndex, 10);
  mappings[activeSwatchIndex].label = idx;
  saveMappings();
  updateSwatchForRow(activeSwatchIndex, idx);
  closePopover();
});

document.addEventListener("click", (e) => {
  if (activeSwatchIndex === -1) return;
  if (!colorPopoverEl.contains(e.target) && !e.target.closest(".color-swatch")) {
    closePopover();
  }
}, true);

function closePopover() {
  colorPopoverEl.classList.add("hidden");
  activeSwatchIndex = -1;
}

function openPopover(mappingIndex, swatchEl) {
  if (activeSwatchIndex === mappingIndex) { closePopover(); return; }
  closePopover();
  activeSwatchIndex = mappingIndex;
  colorPopoverEl.querySelectorAll(".color-option").forEach(el => {
    el.classList.toggle("active", parseInt(el.dataset.labelIndex, 10) === mappings[mappingIndex].label);
  });
  const rect = swatchEl.getBoundingClientRect();
  const pw = colorPopoverEl.offsetWidth || 152;
  const left = Math.min(rect.left, window.innerWidth - pw - 8);
  colorPopoverEl.style.top = (rect.bottom + 4) + "px";
  colorPopoverEl.style.left = Math.max(4, left) + "px";
  colorPopoverEl.classList.remove("hidden");
}

function updateSwatchForRow(rowIndex, labelIndex) {
  const tr = tableBody.querySelector(`tr[data-row-index="${rowIndex}"]`);
  if (!tr) return;
  const swatch = tr.querySelector(".color-swatch");
  if (!swatch) return;
  const color = LABEL_COLORS[labelIndex];
  swatch.style.backgroundColor = color.hex;
  swatch.title = color.name;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTable() {
  tableBody.innerHTML = "";
  mappings.forEach((mapping, i) => {
    const tr = document.createElement("tr");
    tr.dataset.rowIndex = i;

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
    tdDrive.className = "td-drive";
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

    const btnAbs = document.createElement("button");
    btnAbs.type = "button";
    btnAbs.className = "btn-abs-toggle";
    btnAbs.textContent = "abs";
    btnAbs.title = "Show resolved absolute path";
    let rowShowAbs = false;
    btnAbs.addEventListener("click", async () => {
      rowShowAbs = !rowShowAbs;
      btnAbs.classList.toggle("active", rowShowAbs);
      if (rowShowAbs) {
        try {
          const resolved = await evalScript(`resolveDrivePath(${JSON.stringify(mappings[i].drivePath)})`);
          inpDrive.value = resolved;
          inpDrive.readOnly = true;
          inpDrive.style.color = "";
          btnAbs.title = "Show stored path";
        } catch (e) {
          rowShowAbs = false;
          btnAbs.classList.remove("active");
          log("Could not resolve path: " + e.message, "warn");
        }
      } else {
        inpDrive.value = mappings[i].drivePath;
        inpDrive.readOnly = false;
        updateDriveStyle(mappings[i].drivePath);
        btnAbs.title = "Show resolved absolute path";
      }
    });

    tdDrive.appendChild(inpDrive);
    tdDrive.appendChild(btnAbs);
    tr.appendChild(tdDrive);

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

    // Label color swatch
    const tdColor = document.createElement("td");
    tdColor.className = "td-color";
    const swatch = document.createElement("span");
    swatch.className = "color-swatch";
    swatch.style.backgroundColor = LABEL_COLORS[mapping.label ?? 0].hex || "transparent";
    swatch.title = LABEL_COLORS[mapping.label ?? 0].name;
    swatch.addEventListener("click", (e) => { e.stopPropagation(); openPopover(i, swatch); });
    tdColor.appendChild(swatch);
    tr.appendChild(tdColor);

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

// ---------------------------------------------------------------------------
// Add / Remove rows
// ---------------------------------------------------------------------------

function addRow() {
  mappings.push({ binPath: "", drivePath: "", label: 0 });
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
    imported.forEach(m => { if (m.label === undefined) m.label = 0; });
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

  const lastSyncEpoch = 0;
  const queue = [{ binPath: mapping.binPath, fsPath: mapping.drivePath, label: mapping.label ?? 0 }];
  let totalImported = 0, totalSkipped = 0, totalFailed = 0, unchangedCount = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, Math.min(BATCH_SIZE, queue.length));
    const script = `syncFolderBatch(${JSON.stringify(batch)}, ${lastSyncEpoch}, ${JSON.stringify(ignorePatterns)})`;
    const raw = await evalScript(script);
    let results;
    try { results = JSON.parse(raw); } catch (_) { results = { error: raw }; }
    if (results.error) { log(`Sync error: ${results.error}`, "error"); break; }

    for (const result of results) {
      if (result.error) {
        log(`  Error in "${result.binPath}": ${result.error}`, "warn");
      } else {
        totalImported += result.imported;
        (result.importedFiles || []).forEach((p) => log(`  Imported: ${p}`));
        totalSkipped  += result.skipped;
        totalFailed   += result.failed || 0;
        if (!result.changed) { unchangedCount++; }
        (result.warnings || []).forEach((w) => log(`  Warning: ${w}`, "warn"));
        for (const sub of result.subfolders) queue.push(sub);
      }
    }
  }

  const failedNote    = totalFailed    > 0 ? `, ${totalFailed} failed`       : "";
  const unchangedNote = unchangedCount > 0 ? `, ${unchangedCount} unchanged` : "";
  log(`"${mapping.binPath}": imported ${totalImported}, skipped ${totalSkipped}${failedNote}${unchangedNote}.`, totalFailed > 0 ? "warn" : "success");
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
btnFilters.addEventListener("click", toggleFiltersView);
btnAddFilter.addEventListener("click", addFilterPattern);
filterInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addFilterPattern(); });

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
loadFilters();
renderTable();
log("Plugin ready.");
setStatus("Ready");
