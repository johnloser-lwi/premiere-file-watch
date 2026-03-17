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
// Recursive sync
// ---------------------------------------------------------------------------

/**
 * Recursively sync a filesystem folder into a Premiere bin.
 * @param {string} folderPath      native filesystem path
 * @param {ProjectItem} bin
 * @param {number} labelColorIndex  0 = no label; 1-12 = Premiere color index
 * @param {Object} stats            { imported, skipped, warnings }
 */
function syncFolderToBin(folderPath, bin, labelColorIndex, stats, lastSyncEpoch) {
  var folder = new Folder(folderPath);
  if (!folder.exists) {
    stats.warnings.push("Folder not found: " + folderPath);
    return;
  }

  var allEntries = folder.getFiles();

  // Skip import work if this folder hasn't been modified since the last sync.
  // Subfolders are still recursed — their own mtime is checked independently.
  var folderChanged = (lastSyncEpoch <= 0) || (folder.modified.getTime() > lastSyncEpoch);

  if (folderChanged) {
    var toImport = [];
    var alreadyImported = getImportedFilenames(bin);

    for (var i = 0; i < allEntries.length; i++) {
      var entry = allEntries[i];
      if (entry instanceof File) {
        // Use displayName: File.name is URL-encoded ("my%20file.jpeg"),
        // but Premiere stores items with the decoded display name ("my file.jpeg").
        var displayName = entry.displayName;
        if (isMediaFile(displayName)) {
          if (alreadyImported[displayName]) {
            stats.skipped++;
          } else {
            toImport.push(entry.fsName);
          }
        }
      }
    }

    if (toImport.length > 0) {
      app.project.importFiles(toImport, true, bin, false);
      stats.imported += toImport.length;
    }

    // Apply label color to the bin itself and all direct media children (-1 = skip)
    if (labelColorIndex >= 0) {
      try { bin.setColorLabel(labelColorIndex); } catch (e) { /* ignore */ }
      var binChildren = bin.children;
      for (var c = 0; c < binChildren.numItems; c++) {
        var child = binChildren[c];
        if (child.type !== 3) { // apply to media items and sub-bins, skip ROOT
          try { child.setColorLabel(labelColorIndex); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  // Always recurse — each subfolder's mtime is checked independently
  for (var j = 0; j < allEntries.length; j++) {
    var sub = allEntries[j];
    if (sub instanceof Folder) {
      // Use displayName: decoded name matches Premiere's bin name
      var subBin = findOrCreateBin(bin, sub.displayName);
      syncFolderToBin(sub.fsName, subBin, labelColorIndex, stats, lastSyncEpoch);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — called from panel JS via cs.evalScript()
// ---------------------------------------------------------------------------

/**
 * Sync one mapping.
 * @param {string} binPath         slash-delimited bin path
 * @param {string} drivePath       native filesystem path to watch folder
 * @param {number} labelColorIndex 0 = no label; 1-12 = Premiere color index
 * @returns {string} JSON: { imported, skipped, warnings } | { error }
 */
function syncMapping(binPath, drivePath, labelColorIndex, lastSyncEpoch) {
  labelColorIndex = parseInt(labelColorIndex, 10) || 0;
  lastSyncEpoch = +lastSyncEpoch || 0;
  if (!trimStr(binPath) || !trimStr(drivePath)) {
    return JSON.stringify({ error: "Empty bin path or drive path." });
  }
  try {
    if (!app.project) {
      return JSON.stringify({ error: "No active Premiere project." });
    }
    var resolvedPath = resolveDrivePath(trimStr(drivePath));
    var bin = navigateOrCreateBinPath(binPath);
    var stats = { imported: 0, skipped: 0, warnings: [] };
    syncFolderToBin(resolvedPath, bin, labelColorIndex, stats, lastSyncEpoch);
    return JSON.stringify({
      imported: stats.imported,
      skipped: stats.skipped,
      warnings: stats.warnings
    });
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
}
