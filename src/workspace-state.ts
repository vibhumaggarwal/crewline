import type { Agent } from "../shared/types";

// Resolve only within the visible project, and never silently pick among workers.
export function commandRecipient(
  agents: Agent[],
  selectedId: string,
  viewedId?: string,
) {
  const ready = agents.filter((a) => a.status === "ready" && !!a.workspace);
  const selected = ready.find((a) => a.id === selectedId);
  if (selected) return selected;
  const viewed = ready.find((a) => a.id === viewedId);
  return viewed || (ready.length === 1 ? ready[0] : undefined);
}
