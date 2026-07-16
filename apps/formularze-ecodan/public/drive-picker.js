// Wspolna przegladarka Dysku Google (folder albo plik) - okienko podobne do
// wyboru pliku z komputera, tylko pokazuje zawartosc Dysku zamiast dysku
// uzytkownika. Uzywane zarowno do wyboru FOLDERU (zamiast wpisywania
// sciezki recznie), jak i do wyboru pliku Excel/Arkusza Google bezposrednio
// z Dysku (zamiast pobierania i wgrywania).
(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function buildOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "drive-picker-overlay";
    overlay.innerHTML = `
      <div class="drive-picker-box">
        <div class="drive-picker-header">
          <strong class="drive-picker-title">Przeglądaj Dysk Google</strong>
          <button type="button" class="drive-picker-close" aria-label="Zamknij">✕</button>
        </div>
        <div class="drive-picker-path"></div>
        <div class="drive-picker-list"></div>
        <div class="drive-picker-footer">
          <span class="drive-picker-status"></span>
          <button type="button" class="drive-picker-select" hidden>Wybierz ten folder</button>
        </div>
      </div>
    `;
    return overlay;
  }

  function injectStyles() {
    if (document.getElementById("drive-picker-styles")) return;
    const style = document.createElement("style");
    style.id = "drive-picker-styles";
    style.textContent = `
      .drive-picker-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 9999; display: flex; align-items: center; justify-content: center; }
      .drive-picker-box { background: var(--panel-bg, #fff); color: var(--panel-fg, #111); border-radius: 10px; width: min(560px, 92vw); max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
      .drive-picker-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(127,127,127,.25); }
      .drive-picker-close { background: none; border: none; font-size: 16px; cursor: pointer; padding: 4px 8px; }
      .drive-picker-path { padding: 8px 16px; font-size: 13px; opacity: .75; word-break: break-word; }
      .drive-picker-list { overflow-y: auto; flex: 1; padding: 4px 8px; min-height: 200px; }
      .drive-picker-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
      .drive-picker-item:hover { background: rgba(127,127,127,.15); }
      .drive-picker-item .icon { width: 20px; text-align: center; }
      .drive-picker-item .badge { font-size: 11px; opacity: .7; margin-left: auto; }
      .drive-picker-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; border-top: 1px solid rgba(127,127,127,.25); }
      .drive-picker-status { font-size: 13px; opacity: .75; }
    `;
    document.head.appendChild(style);
  }

  // mode: "folder" (wybor katalogu, klikanie plikow nic nie robi) albo
  // "file" (klikniecie pliku od razu wybiera go i zamyka okno).
  window.openDrivePicker = function openDrivePicker({ mode = "folder", startPath = ".", onSelect }) {
    injectStyles();
    const overlay = buildOverlay();
    document.body.appendChild(overlay);
    let currentPath = startPath || ".";

    const pathEl = overlay.querySelector(".drive-picker-path");
    const listEl = overlay.querySelector(".drive-picker-list");
    const statusEl = overlay.querySelector(".drive-picker-status");
    const selectBtn = overlay.querySelector(".drive-picker-select");
    const titleEl = overlay.querySelector(".drive-picker-title");
    titleEl.textContent = mode === "file" ? "Wybierz plik Excel / Arkusz Google" : "Wybierz folder";
    selectBtn.hidden = mode !== "folder";

    function close() { overlay.remove(); }
    overlay.querySelector(".drive-picker-close").addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

    async function load(path) {
      currentPath = path;
      pathEl.textContent = path === "." ? "/ (górny poziom Dysku Projektów)" : "/" + path;
      listEl.innerHTML = "";
      statusEl.textContent = "Wczytuję...";
      try {
        const res = await fetch("/api/drive-browse?path=" + encodeURIComponent(path), { cache: "no-store" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "Nie udało się wczytać zawartości folderu.");
        statusEl.textContent = `${data.entries.length} pozycji`;
        renderEntries(data.entries);
      } catch (err) {
        statusEl.textContent = "";
        listEl.innerHTML = `<div class="drive-picker-item" style="opacity:.7">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderEntries(entries) {
      if (path_hasParent(currentPath)) {
        const up = document.createElement("div");
        up.className = "drive-picker-item";
        up.innerHTML = `<span class="icon">⬆️</span><span>.. (wyżej)</span>`;
        up.addEventListener("click", () => load(parentPath(currentPath)));
        listEl.appendChild(up);
      }
      for (const entry of entries) {
        if (!entry.isDirectory && mode !== "file") continue; // tryb wyboru folderu - pliki tylko do orientacji, pomijamy
        const row = document.createElement("div");
        row.className = "drive-picker-item";
        const icon = entry.isDirectory ? "📁" : (entry.isNativeExport ? "📊" : "📄");
        const badge = entry.isNativeExport ? "Arkusz Google" : "";
        row.innerHTML = `<span class="icon">${icon}</span><span>${escapeHtml(entry.name)}</span><span class="badge">${badge}</span>`;
        row.addEventListener("click", () => {
          if (entry.isDirectory) {
            load(joinPath(currentPath, entry.name));
          } else if (mode === "file") {
            onSelect(joinPath(currentPath, entry.name));
            close();
          }
        });
        listEl.appendChild(row);
      }
    }

    function joinPath(base, name) {
      return base === "." ? name : base + "/" + name;
    }
    function path_hasParent(p) {
      return p !== ".";
    }
    function parentPath(p) {
      const idx = p.lastIndexOf("/");
      return idx === -1 ? "." : p.slice(0, idx);
    }

    selectBtn.addEventListener("click", () => {
      onSelect(currentPath === "." ? "" : currentPath);
      close();
    });

    load(currentPath);
  };
})();
