// Seismic Pick Review Workbench — application entry.

import { api } from "./api.js";
import type {
  Conflict,
  DatasetDetail,
  DatasetSummary,
  GroupConsensus,
  Phase,
  Pick,
  SampleInfo,
} from "./types.js";
import { formatClock, fmtSec, toEpoch, toIso } from "./timeutil.js";
import { StationPanel } from "./waveform.js";

type PanelEntry = {
  station: string;
  card: HTMLElement;
  panel: StationPanel;
};

const state = {
  datasets: [] as DatasetSummary[],
  current: null as DatasetDetail | null,
  report: null as { groups: GroupConsensus[]; conflicts: Conflict[] } | null,
  panels: [] as PanelEntry[],
  selectedId: null as number | null,
  placePhase: null as Phase | null,
  linkViews: true,
  author: localStorage.getItem("picker.author") || "reviewer",
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// --------------------------------------------------------------------------- //
// Boot
// --------------------------------------------------------------------------- //
async function boot() {
  bindToolbar();
  bindStationArea();
  bindPickEvents();
  renderEditorPanel();
  await refreshDatasetList();
  if (state.datasets.length) {
    await openDataset(state.datasets[0].id);
  }
}

function bindToolbar() {
  $("#file-input").addEventListener("change", onFileChosen);
  $("#btn-import-file").addEventListener("click", () =>
    ($("#file-input") as HTMLInputElement).click(),
  );
  $("#btn-sample").addEventListener("click", (e) => {
    e.stopPropagation();
    void loadSampleMenu();
  });
  $("#btn-refresh").addEventListener("click", refreshDatasetList);

  $("#author").addEventListener("change", (e) => {
    state.author = (e.target as HTMLInputElement).value.trim() || "reviewer";
    localStorage.setItem("picker.author", state.author);
  });
  ($("#author") as HTMLInputElement).value = state.author;

  $("#phase-p").addEventListener("click", () => togglePlace("P"));
  $("#phase-s").addEventListener("click", () => togglePlace("S"));
  $("#default-unc").addEventListener("change", () => {
    const v = defaultUncertainty();
    if (!(v >= 0)) ($("#default-unc") as HTMLInputElement).value = "0.2";
  });

  $("#link-views").addEventListener("change", (e) => {
    state.linkViews = (e.target as HTMLInputElement).checked;
  });

  $("#btn-export-json").addEventListener("click", () => downloadExport("json"));
  $("#btn-export-csv").addEventListener("click", () => downloadExport("csv"));

  $("#dataset-select").addEventListener("change", async (e) => {
    const id = Number((e.target as HTMLSelectElement).value);
    if (id) {
      await openDataset(id);
    } else {
      state.current = null;
      renderEmpty();
      await refreshDatasetList();
    }
  });
}

function bindStationArea() {
  // zoom buttons are per-card and handled via delegation
  $("#stations").addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>("[data-z]");
    if (!btn) return;
    const card = btn.closest(".station-card") as HTMLElement;
    const entry = state.panels.find((p) => p.card === card);
    if (!entry) return;
    if (btn.dataset.z === "in") entry.panel.zoom(1 / 1.6);
    else if (btn.dataset.z === "out") entry.panel.zoom(1.6);
    else if (btn.dataset.z === "reset" && state.current)
      entry.panel.resetWindow(fullT0(), fullT1());
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") togglePlace(null);
  });
}

function bindPickEvents() {
  window.addEventListener("pick-dragged", ((e: CustomEvent) => {
    const { pickId, time, uncertainty } = e.detail as {
      pickId: number;
      time: string;
      uncertainty: number;
    };
    void persistDrag(pickId, time, uncertainty);
  }) as EventListener);
}

async function persistDrag(pickId: number, time: string, uncertainty: number) {
  try {
    const updated = await api.updatePick(pickId, { time, uncertainty });
    replacePick(updated);
    await refreshReport();
    renderPanels();
  } catch (err) {
    alertToast(`拖动保存失败: ${msg(err)}`);
    if (state.current) await openDataset(state.current.id);
  }
}

function defaultUncertainty(): number {
  return parseFloat(($("#default-unc") as HTMLInputElement).value);
}

// --------------------------------------------------------------------------- //
// Dataset list / import
// --------------------------------------------------------------------------- //
async function refreshDatasetList() {
  state.datasets = await api.listDatasets();
  const sel = $("#dataset-select") as HTMLSelectElement;
  sel.innerHTML =
    '<option value="">— 选择数据集 —</option>' +
    state.datasets
      .map((d) => `<option value="${d.id}">#${d.id} ${escapeHtml(d.name)}</option>`)
      .join("");
  if (state.current) sel.value = String(state.current.id);

  const curId = state.current?.id;
  if (state.current && !state.datasets.some((d) => d.id === curId)) {
    state.current = null;
    renderEmpty();
  }
  const hasCurrent = state.datasets.some(
    (d) => d.id === state.current?.id,
  );
  setExportsEnabled(hasCurrent);
}

function setExportsEnabled(enabled: boolean) {
  for (const id of ["#btn-export-json", "#btn-export-csv"]) {
    const btn = $(id) as HTMLButtonElement;
    btn.disabled = !enabled;
    btn.classList.toggle("disabled", !enabled);
  }
}

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const res = await api.importJson(payload);
    alertToast(`已导入 ${res.nChannels} 道波形、${res.nPicks} 条初始拾取`);
    await refreshDatasetList();
    await openDataset(res.id);
  } catch (err) {
    alertToast(`导入失败: ${msg(err)}`);
  } finally {
    input.value = "";
  }
}

async function loadSampleMenu() {
  const menu = $("#sample-menu");
  try {
    const samples: SampleInfo[] = await api.listSamples();
    if (!samples.length) {
      alertToast("未找到内置样例");
      return;
    }
    menu.innerHTML = samples
      .map(
        (s) =>
          `<button class="sample-item" data-file="${escapeHtml(s.file)}">
             <b>${escapeHtml(s.name)}</b>
             <span>${s.nChannels} 道 · ${s.nPicks} 条拾取</span>
           </button>`,
      )
      .join("");
    menu.classList.add("open");

    const close = () => {
      menu.classList.remove("open");
      window.removeEventListener("click", outside);
    };
    const outside = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) close();
    };
    const handler = async (ev: MouseEvent) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>(".sample-item");
      if (!item) return;
      close();
      menu.removeEventListener("click", handler);
      try {
        const res = await api.importSample(item.dataset.file!);
        await refreshDatasetList();
        await openDataset(res.id);
      } catch (err) {
        alertToast(`样例导入失败: ${msg(err)}`);
      }
    };
    menu.addEventListener("click", handler);
    window.addEventListener("click", outside);
  } catch (err) {
    alertToast(msg(err));
  }
}

async function openDataset(id: number) {
  state.current = await api.getDataset(id);
  state.selectedId = null;
  state.placePhase = null;
  ($("#dataset-select") as HTMLSelectElement).value = String(id);
  renderHeader();
  renderStations();
  await refreshReport();
  renderSidebar();
  setExportsEnabled(true);
}

// --------------------------------------------------------------------------- //
// Rendering: header + station cards
// --------------------------------------------------------------------------- //
function renderHeader() {
  const d = state.current!;
  $("#header-info").innerHTML = `
    <span class="chip">#${d.id}</span>
    <b>${escapeHtml(d.name)}</b>
    ${d.source ? `<span class="muted">${escapeHtml(d.source)}</span>` : ""}
    <span class="muted">${formatClock(toEpoch(d.startTime))} →
    ${formatClock(toEpoch(d.endTime))} UTC</span>
    <span class="chip">${d.nStations} 台站</span>
    <span class="chip">${d.nPicks} 拾取</span>`;
}

function stationChannels(station: string) {
  return state
    .current!.channels.filter((c) => c.station === station)
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

function fullT0(): number {
  return Math.min(...state.current!.channels.map((c) => toEpoch(c.startTime)));
}
function fullT1(): number {
  return Math.max(
    ...state.current!.channels.map(
      (c) => toEpoch(c.startTime) + (c.nSamples - 1) / c.sampleRate,
    ),
  );
}

function renderStations() {
  const wrap = $("#stations");
  state.panels.forEach((p) => p.panel.destroy());
  state.panels = [];
  wrap.innerHTML = "";

  const d = state.current!;
  const stations = [...new Set(d.channels.map((c) => c.station))].sort();
  const t0 = fullT0();
  const t1 = fullT1();

  for (const sta of stations) {
    const card = document.createElement("section");
    card.className = "station-card";
    card.dataset.station = sta;
    card.innerHTML = `
      <header class="station-head">
        <h3>${escapeHtml(sta)}</h3>
        <span class="station-badges"></span>
        <div class="station-tools">
          <button data-z="out" title="缩小">−</button>
          <button data-z="in" title="放大">+</button>
          <button data-z="reset" title="复位">复位</button>
        </div>
      </header>
      <div class="canvas-wrap"></div>`;
    wrap.appendChild(card);

    const container = card.querySelector(".canvas-wrap") as HTMLElement;
    const panel = new StationPanel(
      container,
      stationChannels(sta),
      d.picks.filter((p) => p.station === sta),
      [],
      new Set(),
      t0,
      t1,
      {
        onSelect: (pickId) => selectPick(pickId),
        onCreate: (timeEpoch) => void createPickAt(sta, timeEpoch),
        onViewChange: () => syncLinkedViews(card),
      },
    );
    state.panels.push({ station: sta, card, panel });
  }
  updateStationBadges();
}

function syncLinkedViews(sourceCard: HTMLElement) {
  if (!state.linkViews) return;
  const source = state.panels.find((p) => p.card === sourceCard);
  if (!source) return;
  for (const p of state.panels) {
    if (p === source) continue;
    p.panel.setWindow(source.panel.t0, source.panel.t1);
  }
}

function stationPickMap() {
  const map = new Map<string, Pick[]>();
  for (const p of state.current!.picks) {
    const key = `${p.station}|${p.phase}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  return map;
}

function updateStationBadges() {
  const map = stationPickMap();
  for (const { station, card } of state.panels) {
    const badges = card.querySelector(".station-badges") as HTMLElement;
    const parts: string[] = [];
    for (const phase of ["P", "S"] as Phase[]) {
      const list = map.get(`${station}|${phase}`) ?? [];
      const live = list.filter((p) => p.status !== "rejected");
      const g = state.report?.groups.find(
        (g) => g.station === station && g.phase === phase,
      );
      if (!live.length && !list.length) continue;
      const cls =
        g && !g.consistent
          ? "badge-conflict"
          : g && g.consistent
            ? "badge-ok"
            : "";
      parts.push(
        `<span class="badge ${cls}" title="basis ${g?.nBasis ?? 0}/${g?.nTotal ?? live.length}">
           ${phase} ${g ? (g.consistent ? "✓" : "⚠") : ""}
           <small>${g?.nBasis ?? 0}/${g?.nTotal ?? live.length}</small>
         </span>`,
      );
    }
    badges.innerHTML = parts.join("");
  }
}

// --------------------------------------------------------------------------- //
// Consensus report
// --------------------------------------------------------------------------- //
async function refreshReport() {
  if (!state.current) return;
  state.report = await api.consensus(state.current.id);
  renderPanels();
  updateStationBadges();
  renderSidebar();
}

function conflictIdSet(station?: string): Set<number> {
  const ids = new Set<number>();
  for (const c of state.report?.conflicts ?? []) {
    if (station && c.station !== station) continue;
    ids.add(c.pickA);
    ids.add(c.pickB);
  }
  return ids;
}

function renderPanels() {
  if (!state.current || !state.report) return;
  for (const { station, panel } of state.panels) {
    panel.update(
      state.current.picks.filter((p) => p.station === station),
      state.report.groups.filter((g) => g.station === station),
      conflictIdSet(station),
    );
  }
}

// --------------------------------------------------------------------------- //
// Pick create / select / edit
// --------------------------------------------------------------------------- //
function togglePlace(phase: Phase | null) {
  state.placePhase = state.placePhase === phase ? null : phase;
  $("#phase-p").classList.toggle("active", state.placePhase === "P");
  $("#phase-s").classList.toggle("active", state.placePhase === "S");
  for (const { panel } of state.panels) panel.setPlacePhase(state.placePhase);
}

async function createPickAt(station: string, timeEpoch: number) {
  if (!state.placePhase) return;
  const unc = defaultUncertainty();
  try {
    const pick = await api.createPick(state.current!.id, {
      station,
      channel: null,
      phase: state.placePhase,
      time: toIso(timeEpoch),
      uncertainty: Number.isFinite(unc) ? unc : 0.2,
      author: state.author,
    });
    state.current!.picks.push(pick);
    await refreshReport();
    selectPick(pick.id);
  } catch (err) {
    alertToast(`拾取创建失败: ${msg(err)}`);
  }
}

function selectPick(pickId: number) {
  state.selectedId = pickId;
  for (const { panel } of state.panels) panel.setSelected(pickId);
  renderSidebar();
  const row = document.querySelector(`[data-pick-row="${pickId}"]`);
  row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function replacePick(pick: Pick) {
  if (!state.current) return;
  const i = state.current.picks.findIndex((p) => p.id === pick.id);
  if (i >= 0) state.current.picks[i] = pick;
  else state.current.picks.push(pick);
}

function statusLabel(s: Pick["status"]): string {
  return s === "accepted" ? "已接受" : s === "rejected" ? "已拒绝" : "待审";
}

function selectedPick(): Pick | null {
  if (state.selectedId == null) return null;
  return state.current?.picks.find((p) => p.id === state.selectedId) ?? null;
}

// --------------------------------------------------------------------------- //
// Sidebar: conflicts, consensus, pick editor
// --------------------------------------------------------------------------- //
function renderSidebar() {
  renderConflictPanel();
  renderConsensusPanel();
  renderEditorPanel();
}

function renderConflictPanel() {
  const box = $("#panel-conflicts");
  const conflicts = state.report?.conflicts ?? [];
  if (!conflicts.length) {
    box.innerHTML = `<p class="empty-note">未发现不确定窗不重叠的冲突 ✓</p>`;
    return;
  }
  box.innerHTML = conflicts
    .map((c) => {
      const pa = state.current!.picks.find((p) => p.id === c.pickA);
      const pb = state.current!.picks.find((p) => p.id === c.pickB);
      if (!pa || !pb) return "";
      return `<div class="conflict-row ${c.basisOnly ? "basis" : ""}">
        <span class="conflict-head">
          <b>${escapeHtml(c.station)}</b>
          <span class="phase-tag ${c.phase.toLowerCase()}">${c.phase}</span>
          ${c.basisOnly ? '<span class="tag-basis">共识基</span>' : '<span class="tag-mute">非基</span>'}
          间隔 ${fmtSec(c.gap)}
        </span>
        <button class="link-pick" data-pick="${pa.id}">
          ${escapeHtml(pa.author || "—")} · ${pa.status} · ±${pa.uncertainty}s
        </button>
        <button class="link-pick" data-pick="${pb.id}">
          ${escapeHtml(pb.author || "—")} · ${pb.status} · ±${pb.uncertainty}s
        </button>
      </div>`;
    })
    .join("");

  box.querySelectorAll<HTMLElement>(".link-pick").forEach((b) => {
    b.addEventListener("click", () => selectPick(Number(b.dataset.pick)));
  });
}

function renderConsensusPanel() {
  const box = $("#panel-consensus");
  const groups = state.report?.groups ?? [];
  if (!groups.length) {
    box.innerHTML = `<p class="empty-note">尚无可用拾取</p>`;
    return;
  }
  box.innerHTML = groups
    .map((g) => {
      const rows = g.members
        .map((m) => {
          const cls = m.inBasis ? "in-basis" : "not-basis";
          return `<div class="member ${cls}">
            <span>${escapeHtml(m.author || "—")}
              <small>(${m.status})</small></span>
            <span class="mono">w=${(m.weight * 100).toFixed(1)}%</span>
            <span class="mono ${m.distance > 0 ? "pos" : "neg"}">
              ${m.distance >= 0 ? "+" : ""}${fmtSec(m.distance)}</span>
          </div>`;
        })
        .join("");
      return `<div class="consensus-group ${g.consistent ? "" : "conflict"}"
                data-station="${escapeHtml(g.station)}" data-phase="${g.phase}">
        <div class="cg-head">
          <b>${escapeHtml(g.station)}</b>
          <span class="phase-tag ${g.phase.toLowerCase()}">${g.phase}</span>
          ${g.consistent ? '<span class="ok-text">一致</span>' : '<span class="warn-text">冲突</span>'}
        </div>
        <div class="cg-time mono">
          ${g.time ? formatClock(toEpoch(g.time)) : "—"}
          <small>±${g.uncertainty?.toFixed(3) ?? "—"} s</small>
        </div>
        <div class="cg-meta muted">
          基 ${g.nBasis}/${g.nTotal} · 内误差 ${g.uncertaintyInner?.toFixed(3) ?? "—"}s
          · Birge R=${g.birgeFactor?.toFixed(2) ?? "—"}
        </div>
        ${rows}
      </div>`;
    })
    .join("");

  box.querySelectorAll<HTMLElement>(".consensus-group").forEach((el) => {
    el.addEventListener("click", () => {
      const g = state.report!.groups.find(
        (x) => x.station === el.dataset.station && x.phase === el.dataset.phase,
      );
      if (g?.members.length) selectPick(g.members[0].pickId);
    });
  });
}

function renderEditorPanel() {
  const box = $("#panel-editor");
  const p = selectedPick();
  if (!p) {
    box.innerHTML = `<p class="empty-note">点击或双击波形上的拾取线进行编辑；
      也可先选择 P / S 放置模式，再在波形上点击添加。</p>`;
    return;
  }
  const conflict = conflictIdSet().has(p.id) && p.status !== "rejected";
  const t = toEpoch(p.time);
  box.innerHTML = `
    <div class="editor ${conflict ? "is-conflict" : ""}">
      <div class="editor-head">
        <span class="phase-tag ${p.phase.toLowerCase()}">${p.phase}</span>
        <b>#${p.id}</b>
        <span class="status-tag status-${p.status}">${statusLabel(p.status)}</span>
        ${conflict ? '<span class="warn-text">⚠ 冲突</span>' : ""}
      </div>
      <label>台站 <input value="${escapeHtml(p.station)}" disabled /></label>
      <label>通道
        <select id="ed-channel">
          <option value="">（全部）</option>
          ${stationChannels(p.station)
            .map(
              (c) =>
                `<option ${c.channel === p.channel ? "selected" : ""}>${c.channel}</option>`,
            )
            .join("")}
        </select>
      </label>
      <label>到时 (相对数据集起点秒数)
        <input id="ed-time" type="number" step="0.001"
          value="${(t - fullT0()).toFixed(3)}" />
      </label>
      <label>±不确定窗 (s)
        <input id="ed-unc" type="number" min="0" step="0.01"
          value="${p.uncertainty}" />
      </label>
      <label class="muted mono clockline">${formatClock(t)} UTC</label>
      <label>作者 <input id="ed-author" value="${escapeHtml(p.author)}" /></label>
      <label>相型
        <select id="ed-phase">
          <option ${p.phase === "P" ? "selected" : ""}>P</option>
          <option ${p.phase === "S" ? "selected" : ""}>S</option>
        </select>
      </label>
      <div class="editor-actions">
        ${
          p.status !== "accepted"
            ? '<button class="btn-ok" data-act="accept">✓ 接受</button>'
            : ""
        }
        ${
          p.status !== "rejected"
            ? '<button class="btn-reject" data-act="reject">✗ 拒绝</button>'
            : '<button data-act="reset">↺ 撤回拒绝</button>'
        }
        ${
          p.status !== "pending"
            ? '<button data-act="pending">撤销决定</button>'
            : ""
        }
        <button class="btn-danger" data-act="delete">删除</button>
      </div>
    </div>`;

  const save = async (patch: Parameters<typeof api.updatePick>[1]) => {
    try {
      replacePick(await api.updatePick(p.id, patch));
      await refreshReport();
    } catch (err) {
      alertToast(`保存失败: ${msg(err)}`);
    }
  };

  ($("#ed-channel") as HTMLSelectElement).addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    void save({ channel: v || null });
  });
  ($("#ed-author") as HTMLInputElement).addEventListener("change", (e) => {
    void save({ author: (e.target as HTMLInputElement).value });
  });
  ($("#ed-phase") as HTMLSelectElement).addEventListener("change", (e) => {
    void save({ phase: (e.target as HTMLSelectElement).value as Phase });
  });
  ($("#ed-time") as HTMLInputElement).addEventListener("change", (e) => {
    const rel = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(rel)) return;
    void save({ time: toIso(fullT0() + rel) });
  });
  ($("#ed-unc") as HTMLInputElement).addEventListener("change", (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (!(v >= 0)) return;
    void save({ uncertainty: v });
  });

  box.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      if (act === "accept") await save({ status: "accepted" });
      else if (act === "reject") await save({ status: "rejected" });
      else if (act === "pending") await save({ status: "pending" });
      else if (act === "reset") await save({ status: "pending" });
      else if (act === "delete") {
        if (!confirm(`删除拾取 #${p.id}？`)) return;
        await api.deletePick(p.id);
        state.current!.picks = state.current!.picks.filter((x) => x.id !== p.id);
        state.selectedId = null;
        await refreshReport();
      }
    });
  });
}

// --------------------------------------------------------------------------- //
// Export / misc
// --------------------------------------------------------------------------- //
function downloadExport(format: "json" | "csv") {
  if (!state.current) return;
  window.location.href = api.exportUrl(state.current.id, format);
}

function renderEmpty() {
  $("#header-info").innerHTML =
    '<span class="muted">导入波形 JSON 或加载内置样例开始审阅</span>';
  $("#stations").innerHTML = "";
  state.panels = [];
  $("#panel-conflicts").innerHTML = "";
  $("#panel-consensus").innerHTML = "";
  setExportsEnabled(false);
  renderEditorPanel();
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function alertToast(text: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

void boot();
