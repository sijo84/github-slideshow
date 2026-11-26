// stub (W0): replaced by task W10

export function NotesPopover(_props: { subjectId: string; name: string; onClose: () => void }) {
  return null;
}

/** Stub: inert (no notes) rather than throwing, so components of parallel tasks that call it can render. */
export function useNotes(): Record<string, { text: string; color: string | null }> {
  return {};
}
