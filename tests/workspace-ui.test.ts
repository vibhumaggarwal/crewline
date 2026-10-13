import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "../shared/types";
import { commandRecipient } from "../src/workspace-state";

const worker = (id: string, status = "ready") =>
  ({ id, status, workspace: `/worktrees/${id}` }) as Agent;
test("composer cannot target a worker outside the visible project", () => {
  const visible = [worker("new-a"), worker("new-b")];
  assert.equal(commandRecipient(visible, "previous-project-worker"), undefined);
  assert.equal(commandRecipient(visible, "new-b")?.id, "new-b");
  assert.equal(commandRecipient(visible, "", "new-a")?.id, "new-a");
});
test("composer selects a sole ready worker but never guesses among several", () => {
  assert.equal(commandRecipient([], ""), undefined);
  assert.equal(commandRecipient([worker("one")], "")?.id, "one");
  assert.equal(commandRecipient([worker("one"), worker("two")], ""), undefined);
  assert.equal(
    commandRecipient([worker("broken", "error")], "broken"),
    undefined,
  );
  assert.equal(
    commandRecipient([{ ...worker("preparing"), workspace: "" }], "preparing"),
    undefined,
  );
});
