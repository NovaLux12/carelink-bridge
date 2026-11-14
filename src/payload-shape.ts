import type { CareLinkData } from './types/carelink.js';

/**
 * Does this CareLink payload contain anything worth uploading?
 *
 * This exists because the fetch loop used to answer that question with a single
 * field — `lastMedicalDeviceDataUpdateServerTime` — and v13 `display/message`
 * never sends it (`src/transform/index.ts` says so, and
 * `test/ble-payload-shape.test.ts` builds the v13 fixture by deleting it). The
 * result was that the bridge fetched good data on the exact device the v0.3
 * line targets, called it `Empty or invalid data`, and uploaded nothing.
 *
 * So the test is CONTENT, not one legacy clock:
 *
 *   - a device clock  → the legacy/connect-data shape, and the staleness gate
 *                       in `transform()` can run against it;
 *   - a non-empty `sgs[]` → the display/message shape, which is self-dating
 *                       because each reading carries its own timestamp.
 *
 * Deliberately NOT satisfied by `lastSG` alone or by a markers-only payload:
 * a marker array with no anchor cannot be dated (see `mapMarkers`), so
 * accepting it here would only move the failure downstream into a throw.
 */
export function isUsablePayload(data: CareLinkData | null | undefined): boolean {
  if (!data) return false;
  if (Number.isFinite(data.lastMedicalDeviceDataUpdateServerTime)) return true;
  return Array.isArray(data.sgs) && data.sgs.length > 0;
}
