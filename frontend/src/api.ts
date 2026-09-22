// Thin fetch wrapper for the JSON API.

import type {
  ConsensusReport,
  DatasetDetail,
  DatasetSummary,
  Pick,
  PickInput,
  PickStatus,
  Phase,
  SampleInfo,
} from "./types.js";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listDatasets: () => request<DatasetSummary[]>("/api/datasets"),
  getDataset: (id: number) => request<DatasetDetail>(`/api/datasets/${id}`),
  deleteDataset: (id: number) =>
    request<void>(`/api/datasets/${id}`, { method: "DELETE" }),
  importJson: (payload: unknown) =>
    request<{ id: number; nChannels: number; nPicks: number }>(
      "/api/datasets/import",
      { method: "POST", body: JSON.stringify(payload) },
    ),
  listSamples: () => request<SampleInfo[]>("/api/samples"),
  importSample: (file: string) =>
    request<{ id: number }>(`/api/samples/${encodeURIComponent(file)}/import`, {
      method: "POST",
    }),
  createPick: (datasetId: number, body: PickInput) =>
    request<Pick>(`/api/datasets/${datasetId}/picks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updatePick: (
    pickId: number,
    patch: Partial<{
      time: string;
      uncertainty: number;
      phase: Phase;
      channel: string | null;
      author: string;
      status: PickStatus;
    }>,
  ) =>
    request<Pick>(`/api/picks/${pickId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deletePick: (pickId: number) =>
    request<void>(`/api/picks/${pickId}`, { method: "DELETE" }),
  consensus: (datasetId: number) =>
    request<ConsensusReport>(`/api/datasets/${datasetId}/consensus`),
  exportUrl: (datasetId: number, format: "json" | "csv") =>
    `/api/datasets/${datasetId}/export?format=${format}`,
};
