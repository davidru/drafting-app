import type { DraftingAPI } from '../preload/preload';

declare global {
  interface Window {
    drafting: DraftingAPI;
  }
}
