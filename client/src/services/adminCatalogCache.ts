import { adminApi } from './api';

const CATALOG_TTL_MS = 60_000;
let cachedCatalog: { data: any; expiresAt: number } | null = null;
let inFlight: Promise<any> | null = null;

export async function getQuestionCatalogSummaryCached(): Promise<any> {
  if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) return cachedCatalog.data;
  if (!inFlight) {
    inFlight = adminApi.getQuestionCatalogSummary()
      .then((response) => {
        cachedCatalog = { data: response.data, expiresAt: Date.now() + CATALOG_TTL_MS };
        return response.data;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export function invalidateQuestionCatalogSummary(): void {
  cachedCatalog = null;
}
