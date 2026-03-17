// hostscript.jsx — ExtendScript for File Watch CEP extension
// Runs inside Premiere Pro's scripting engine.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var MEDIA_EXTENSIONS = (function () {
  var exts = [
    "mp4","mov","mxf","avi","mkv","r3d","braw",
    "mp3","wav","aif","aiff","aac","flac","m4a",
    "jpg","jpeg","png","gif","bmp","tif","tiff",
    "psd","arw","cr2","cr3","nef","dng"
  ];
  var map = {};
  for (var i = 0; i < exts.length; i++) { map[exts[i]] = 1; }
  return map;
}());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMediaFile(name) {
  var dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return !!MEDIA_EXTENSIONS[name.slice(dot + 1).toLowerCase()];
}

function trimStr(s) {
  return s.replace(/^\s+|\s+$/g, "");
}

// ---------------------------------------------------------------------------
// Folder browsing
// ---------------------------------------------------------------------------

/**
 * Returns the project file's parent directory as a Folder, or null.
 */
function getProjectDir() {
  if (!app.project || !app.project.path) return null;
  return new File(app.project.path).parent;
}

/**
 * Resolve a drive path that may be relative (e.g. "./Footage") against the
 * project file's directory. Absolute paths are returned unchanged.
 * @param {string} drivePath
 * @returns {string} resolved native filesystem path
 */
function resolveDrivePath(drivePath) {
  // Normalize to forward slashes — Folder() accepts / on both Mac and Windows
  var p = drivePath.replace(/\\/g, '/');
  var ch0 = p.charAt(0);
  var ch1 = p.charAt(1);
  var ch2 = p.charAt(2);
  var isAbsolute = ch0 === '/' || (ch1 === ':' && ch2 === '/');
  if (isAbsolute) return new Folder(p).fsName;

  var projectDir = getProjectDir();
  if (!projectDir) {
    throw new Error("Cannot resolve relative path \"" + drivePath + "\": no active project with a saved path.");
  }
  var base = projectDir.fsName.replace(/\\/g, '/');
  return new Folder(base + '/' + p).fsName;
}

/**
 * Shows a native folder picker.
 * If the chosen folder is inside the project directory, returns a relative
 * path (e.g. "./Footage/Camera A"). Otherwise returns the absolute path.
 */
function browseFolder() {
  var folder = Folder.selectDialog("Select folder to watch");
  if (!folder) return "";

  var projectDir = getProjectDir();
  if (projectDir) {
    var projectDirPath = projectDir.fsName;
    var folderPath = folder.fsName;
    if (folderPath.indexOf(projectDirPath) === 0) {
      var rel = folderPath.slice(projectDirPath.length).replace(/\\/g, '/');
      if (rel.charAt(0) === '/') rel = rel.slice(1);
      return './' + rel;
    }
  }

  return folder.fsName;
}

// ---------------------------------------------------------------------------
// Bin utilities
// ---------------------------------------------------------------------------

/**
 * Find or create a bin with `name` inside `parentItem`.
 * Merges duplicate bins: moves all children to the first match, deletes extras.
 * @param {ProjectItem} parentItem
 * @param {string} name
 * @returns {ProjectItem}
 */
function findOrCreateBin(parentItem, name) {
  var children = parentItem.children;
  var matches = [];
  for (var i = 0; i < children.numItems; i++) {
    var child = children[i];
    // Use literal 2 for BIN — ProjectItemType enum is not reliable in CEP ExtendScript
    if (child.type === 2 && child.name === name) {
      matches.push(child);
    }
  }

  if (matches.length === 0) {
    return parentItem.createBin(name);
  }

  if (matches.length === 1) {
    return matches[0];
  }

  // Merge duplicates into the first bin
  var primary = matches[0];
  for (var d = 1; d < matches.length; d++) {
    var dup = matches[d];
    var dupChildren = dup.children;
    // Collect first — moving items modifies the collection
    var toMove = [];
    for (var c = 0; c < dupChildren.numItems; c++) {
      toMove.push(dupChildren[c]);
    }
    for (var m = 0; m < toMove.length; m++) {
      toMove[m].moveBin(primary);
    }
    dup.delete(false, false);
  }

  return primary;
}

/**
 * Navigate or create bins along a slash-delimited path from project root.
 * e.g. "Footage/Camera A" → creates/finds Footage bin, then Camera A inside it.
 * @param {string} binPathStr
 * @returns {ProjectItem} the deepest bin
 */
function navigateOrCreateBinPath(binPathStr) {
  var parts = binPathStr.split("/");
  var current = app.project.rootItem;
  for (var i = 0; i < parts.length; i++) {
    var part = trimStr(parts[i]);
    if (!part) continue;
    current = findOrCreateBin(current, part);
  }
  return current;
}

/**
 * Return a lookup object of filenames already present in the bin (any media type).
 * Excludes bins (type 2) and root (type 3) — everything else is considered media.
 * @param {ProjectItem} bin
 * @returns {Object} { filename: 1, ... }
 */
function getImportedFilenames(bin) {
  var names = {};
  var children = bin.children;
  for (var i = 0; i < children.numItems; i++) {
    var child = children[i];
    if (child.type !== 2 && child.type !== 3) { // not BIN, not ROOT
      names[child.name] = 1;
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Public API — called from panel JS via cs.evalScript()
// ---------------------------------------------------------------------------

/**
 * Process a batch of folders in one evalScript call to amortise CEP IPC overhead.
 * @param {Array}  jobs          array of { binPath, fsPath }
 * @param {number} lastSyncEpoch ms epoch; 0 = force full scan
 * @returns {string} JSON array of per-folder results: { binPath, imported, skipped, failed, warnings, subfolders, changed } | { error }
 */
function syncFolderBatch(jobs, lastSyncEpoch) {
  lastSyncEpoch = +lastSyncEpoch || 0;
  try {
    if (!app.project) return JSON.stringify({ error: "No active Premiere project." });
    var results = [];
    for (var b = 0; b < jobs.length; b++) {
      var binPath = jobs[b].binPath;
      var fsPath  = jobs[b].fsPath;
      var resolvedPath = resolveDrivePath(trimStr(fsPath));
      var folder = new Folder(resolvedPath);
      if (!folder.exists) {
        results.push({ binPath: binPath, error: "Folder not found: " + resolvedPath });
        continue;
      }

      var allEntries = folder.getFiles();
      var subfolders = [];
      for (var j = 0; j < allEntries.length; j++) {
        if (allEntries[j] instanceof Folder) {
          subfolders.push({ binPath: binPath + "/" + allEntries[j].displayName, fsPath: allEntries[j].fsName });
        }
      }

      var folderChanged = (lastSyncEpoch <= 0) || (folder.modified.getTime() > lastSyncEpoch);
      if (!folderChanged) {
        allEntries = null;
        results.push({ binPath: binPath, imported: 0, skipped: 0, failed: 0, warnings: [], subfolders: subfolders, changed: false });
        continue;
      }

      var bin = navigateOrCreateBinPath(binPath);
      var alreadyImported = getImportedFilenames(bin);
      var toImport = [];
      var skipped = 0;
      for (var i = 0; i < allEntries.length; i++) {
        if (allEntries[i] instanceof File) {
          var displayName = allEntries[i].displayName;
          if (isMediaFile(displayName)) {
            if (alreadyImported[displayName]) { skipped++; } else { toImport.push(allEntries[i].fsName); }
          }
        }
      }
      allEntries = null;
      alreadyImported = null;

      var imported = 0, failed = 0, warnings = [];
      if (toImport.length > 0) {
        try {
          app.project.importFiles(toImport, true, bin, false);
          imported = toImport.length;
        } catch (e) {
          failed = toImport.length;
          warnings.push("importFiles failed: " + (e.message || String(e)));
        }
      }
      toImport = null;
      bin = null;

      results.push({ binPath: binPath, imported: imported, skipped: skipped, failed: failed, warnings: warnings, subfolders: subfolders, changed: true });
    }
    return JSON.stringify(results);
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
}

