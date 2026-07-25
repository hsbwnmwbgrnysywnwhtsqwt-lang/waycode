import { test } from "node:test";
import assert from "node:assert/strict";
import { History } from "../memory/History";

/** Minimal in-memory Memento stand-in. */
function fakeMemento() {
  const store: Record<string, unknown> = {};
  return {
    get(key: string, def?: unknown) {
      return key in store ? store[key] : def;
    },
    async update(key: string, value: unknown) {
      store[key] = value;
    },
    keys() {
      return Object.keys(store);
    },
  } as any;
}

test("save then list returns the session for its workspace", async () => {
  const h = new History(fakeMemento());
  const s = History.newSession("/ws/a");
  s.title = "hello";
  s.messages.push({ role: "user", content: "hi" }, { role: "assistant", content: "hey" });
  await h.save(s);

  const list = h.list("/ws/a");
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "hello");
  assert.equal(h.get(s.id)?.messages.length, 2);
});

test("sessions are scoped per workspace", async () => {
  const h = new History(fakeMemento());
  const a = History.newSession("/ws/a");
  a.messages.push({ role: "user", content: "a" });
  const b = History.newSession("/ws/b");
  b.messages.push({ role: "user", content: "b" });
  await h.save(a);
  await h.save(b);

  assert.equal(h.list("/ws/a").length, 1);
  assert.equal(h.list("/ws/b").length, 1);
  assert.equal(h.list("/ws/c").length, 0);
});

test("empty sessions are not saved or listed", async () => {
  const h = new History(fakeMemento());
  await h.save(History.newSession("/ws/a"));
  assert.equal(h.list("/ws/a").length, 0);
});

test("re-saving the same session id updates in place", async () => {
  const h = new History(fakeMemento());
  const s = History.newSession("/ws/a");
  s.messages.push({ role: "user", content: "one" });
  await h.save(s);
  s.messages.push({ role: "assistant", content: "two" });
  await h.save(s);
  assert.equal(h.list("/ws/a").length, 1);
  assert.equal(h.get(s.id)?.messages.length, 2);
});
