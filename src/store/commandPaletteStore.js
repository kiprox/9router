"use client";

import { create } from "zustand";

// Global open/close state for the command palette (Cmd/Ctrl+K).
export const useCommandPaletteStore = create((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

export default useCommandPaletteStore;
