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
  if (name.charAt(0) === '.' && name.charAt(1) === '_') return false;
  var dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return !!MEDIA_EXTENSIONS[name.slice(dot + 1).toLowerCase()];
}

function matchesIgnorePattern(name, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    if (!patterns[i]) continue;
    try {
      if (new RegExp(patterns[i], 'i').test(name)) return true;
    } catch (e) { /* invalid regex — skip */ }
  }
  return false;
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
  var created = false;
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
    created = true;
    return [parentItem.createBin(name), created];
  }

  if (matches.length === 1) {
    return [matches[0], created];
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

  return [primary, created];
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
  var created = false;
  for (var i = 0; i < parts.length; i++) {
    var part = trimStr(parts[i]);
    if (!part) continue;
    var res = findOrCreateBin(current, part);
    current = res[0];
    created = res[1];
  }
  return [current, created];
}

/**
 * Return a lookup object of filenames already present in the bin (any media type).
 * Excludes bins (type 2) and root (type 3) — everything else is considered media.
 * @param {ProjectItem} bin
 * @returns {Object} { filename: 1, ... }
 */
function getImportedFilePaths(bin) {
  var paths = {};
  var children = bin.children;
  for (var i = 0; i < children.numItems; i++) {
    var child = children[i];
    if (child.type !== 2 && child.type !== 3) { // not BIN, not ROOT
      var mediaPath = child.getMediaPath();
      if (mediaPath) paths[mediaPath.replace(/\\/g, '/')] = 1;
      // Fallback: also index by name for clips whose path is unavailable
      paths[child.name] = 1;
    }
  }
  return paths;
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
function syncFolderBatch(jobs, lastSyncEpoch, ignorePatterns) {
  lastSyncEpoch = +lastSyncEpoch || 0;
  ignorePatterns = (ignorePatterns && ignorePatterns.length) ? ignorePatterns : [];
  try {
    if (!app.project) return JSON.stringify({ error: "No active Premiere project." });
    var results = [];
    for (var b = 0; b < jobs.length; b++) {
      var binPath = jobs[b].binPath;
      var fsPath  = jobs[b].fsPath;
      var label = (jobs[b].label !== undefined) ? +jobs[b].label : 0;
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
          var folderName = allEntries[j].displayName;
          if (folderName.charAt(0) === '.' && folderName.charAt(1) === '_') continue;
          if (!matchesIgnorePattern(folderName, ignorePatterns)) {
            subfolders.push({ binPath: binPath + "/" + folderName, fsPath: allEntries[j].fsName, label: label });
          }
        }
      }

      var folderChanged = (lastSyncEpoch <= 0) || (folder.modified.getTime() > lastSyncEpoch);
      if (!folderChanged) {
        allEntries = null;
        results.push({ binPath: binPath, imported: 0, skipped: 0, failed: 0, warnings: [], subfolders: subfolders, changed: false });
        continue;
      }

      var res = navigateOrCreateBinPath(binPath);
      var bin = res[0];
      var created = res[1];
      if (created) { try { bin.setColorLabel(label); } catch (ex) {} }
      
      var alreadyImported = getImportedFilePaths(bin);
      var toImport = [];
      var skipped = 0;
      for (var i = 0; i < allEntries.length; i++) {
        if (allEntries[i] instanceof File) {
          var displayName = allEntries[i].displayName;
          if (isMediaFile(displayName) && !matchesIgnorePattern(displayName, ignorePatterns)) {
            var normalizedPath = allEntries[i].fsName.replace(/\\/g, '/');
            if (alreadyImported[normalizedPath] || alreadyImported[displayName]) { skipped++; } else { toImport.push(allEntries[i].fsName); }
          }
        }
      }
      allEntries = null;
      alreadyImported = null;

      var imported = 0, failed = 0, warnings = [], importedFiles = [];
      if (toImport.length > 0) {
        try {
          app.project.importFiles(toImport, true, bin, false);
          var afterImport = getImportedFilePaths(bin);
          for (var ti = 0; ti < toImport.length; ti++) {
            var normalizedImport = toImport[ti].replace(/\\/g, '/');
            if (afterImport[normalizedImport]) {
              imported++;
              importedFiles.push(toImport[ti]);
            } else {
              failed++;
              warnings.push("Silent import failure: " + toImport[ti]);
            }
          }
          afterImport = null;
        } catch (e) {
          failed = toImport.length;
          warnings.push("importFiles failed: " + (e.message || String(e)));
        }
      }
      toImport = null;

      if (imported > 0) {
        var importedSet = {};
        for (var ii = 0; ii < importedFiles.length; ii++) {
          importedSet[importedFiles[ii].replace(/\\/g, '/')] = 1;
        }
        var binChildren = bin.children;
        for (var ci = 0; ci < binChildren.numItems; ci++) {
          var item = binChildren[ci];
          if (item.type !== 2 && item.type !== 3) {
            var itemPath = item.getMediaPath();
            if (itemPath && importedSet[itemPath.replace(/\\/g, '/')]) {
              try { item.setColorLabel(label); } catch (ex) {}
            }
          }
        }
      }
      bin = null;

      results.push({ binPath: binPath, imported: imported, skipped: skipped, failed: failed, warnings: warnings, subfolders: subfolders, changed: true, importedFiles: importedFiles });
    }
    return JSON.stringify(results);
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
}

